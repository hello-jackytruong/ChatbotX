import { describe, expect, it, vi } from 'vitest';
import {
  ProviderCommandConflictError,
  ZaloProviderClient,
} from '../../src/modules/zalo-provider/client.js';

describe('ZaloProviderClient lifecycle facade', () => {
  it('delegates lifecycle and status without exposing SDK instances', async () => {
    const pool = {
      cleanupStaleGhosts: vi.fn().mockResolvedValue(2),
      disconnect: vi.fn(),
      getAllStatuses: vi.fn(() => ({ 'account-1': 'connected' })),
      getApi: vi.fn(() => null),
      getIO: vi.fn(() => ({ name: 'io' })),
      getInstance: vi.fn(() => undefined),
      getStatus: vi.fn(() => 'connected'),
      loginQR: vi.fn().mockResolvedValue(undefined),
      reconnect: vi.fn().mockResolvedValue(undefined),
      setIO: vi.fn(),
    };
    const client = new ZaloProviderClient(pool);

    expect(client.getStatus('account-1')).toBe('connected');
    expect(client.isConnected('account-1')).toBe(true);
    expect(client.getAllStatuses()).toEqual({ 'account-1': 'connected' });
    expect(client.getIO()).toEqual({ name: 'io' });
    client.setIO({ name: 'new-io' } as never);
    await client.loginWithQr('account-1', 'http://synthetic-proxy');
    await client.reconnect('account-1', { cookie: {}, imei: 'synthetic', userAgent: 'synthetic' });
    client.disconnect('account-1');
    await expect(client.cleanupStaleGhosts(15)).resolves.toBe(2);

    expect(pool.loginQR).toHaveBeenCalledWith('account-1', 'http://synthetic-proxy');
    expect(pool.reconnect).toHaveBeenCalledOnce();
    expect(pool.disconnect).toHaveBeenCalledWith('account-1');
    expect(pool.setIO).toHaveBeenCalledOnce();
    expect(client).not.toHaveProperty('getApi');
    expect(client).not.toHaveProperty('getInstance');
  });

  it('executes semantic operations without returning a raw SDK object', async () => {
    const api = {
      getLabels: vi.fn().mockResolvedValue({ labelData: [], version: 1 }),
      getUserInfo: vi.fn().mockResolvedValue({ changed_profiles: {} }),
      sendMessage: vi.fn().mockResolvedValue({ msgId: 'provider-message-1' }),
      updateLabels: vi.fn().mockResolvedValue({ labelData: [], version: 2 }),
    };
    const pool = {
      cleanupStaleGhosts: vi.fn(),
      disconnect: vi.fn(),
      getAllStatuses: vi.fn(() => ({ 'account-1': 'connected' })),
      getApi: vi.fn(() => api),
      getIO: vi.fn(() => null),
      getInstance: vi.fn(() => ({ api, status: 'connected' })),
      getStatus: vi.fn(() => 'connected'),
      loginQR: vi.fn(),
      reconnect: vi.fn(),
      setIO: vi.fn(),
    };
    const client = new ZaloProviderClient(pool);

    await expect(client.sendMessageDirect('account-1', { msg: 'synthetic' }, 'thread-1', 0))
      .resolves.toEqual({ msgId: 'provider-message-1' });
    await expect(client.getUserInfoDirect('account-1', 'user-1'))
      .resolves.toEqual({ changed_profiles: {} });
    await expect(client.getLabelsDirect('account-1'))
      .resolves.toEqual({ labelData: [], version: 1 });

    expect(api.sendMessage).toHaveBeenCalledWith({ msg: 'synthetic' }, 'thread-1', 0);
    expect(api.getUserInfo).toHaveBeenCalledWith('user-1');
    expect(client.supports('account-1', 'labels')).toBe(true);
    expect(client).not.toHaveProperty('getApi');
    expect(client).not.toHaveProperty('getInstance');
  });

  it('fails semantic operations with the legacy disconnected message', async () => {
    const pool = {
      cleanupStaleGhosts: vi.fn(),
      disconnect: vi.fn(),
      getAllStatuses: vi.fn(() => ({})),
      getApi: vi.fn(() => null),
      getIO: vi.fn(() => null),
      getInstance: vi.fn(() => undefined),
      getStatus: vi.fn(() => 'disconnected'),
      loginQR: vi.fn(),
      reconnect: vi.fn(),
      setIO: vi.fn(),
    };
    const client = new ZaloProviderClient(pool);

    await expect(client.getUserInfoDirect('account-1', 'user-1'))
      .rejects.toThrow('Zalo account not connected');
    expect(client.supports('account-1', 'user_info')).toBe(false);
  });

  it('deduplicates identical commands and rejects payload conflicts', async () => {
    const pool = {
      cleanupStaleGhosts: vi.fn(), disconnect: vi.fn(), getAllStatuses: vi.fn(() => ({})),
      getApi: vi.fn(() => null), getIO: vi.fn(() => null), getInstance: vi.fn(() => undefined),
      getStatus: vi.fn(() => 'disconnected'), loginQR: vi.fn(), reconnect: vi.fn(), setIO: vi.fn(),
    };
    const runner = vi.fn().mockResolvedValue({ message: { msgId: 'provider-1' } });
    const client = new ZaloProviderClient(pool, runner);
    const command = {
      version: 1 as const,
      commandId: 'command-1', idempotencyKey: 'echo-1', accountId: 'account-1',
      kind: 'sendMessage' as const, payload: { args: ['thread-1', 0, { msg: 'synthetic' }] },
      requestedAt: '2026-11-07T00:00:00.000Z', deadlineAt: '2026-11-07T00:00:30.000Z', traceId: 'trace-1',
    };

    const [first, replay] = await Promise.all([client.execute(command), client.execute(command)]);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ status: 'succeeded', providerIds: { messageId: 'provider-1' } });
    expect(runner).toHaveBeenCalledOnce();

    await expect(client.execute({
      ...command,
      commandId: 'command-2',
      payload: { args: ['thread-1', 0, { msg: 'different' }] },
    })).rejects.toBeInstanceOf(ProviderCommandConflictError);
  });

  it('routes lifecycle commands through the durable gateway without serializing credentials', async () => {
    const pool = {
      cleanupStaleGhosts: vi.fn(), disconnect: vi.fn(), getAllStatuses: vi.fn(() => ({})),
      getApi: vi.fn(() => null), getIO: vi.fn(() => null), getInstance: vi.fn(() => undefined),
      getStatus: vi.fn(() => 'disconnected'), loginQR: vi.fn(), reconnect: vi.fn(), setIO: vi.fn(),
    };
    const remote = vi.fn().mockResolvedValue({ started: true });
    const client = new ZaloProviderClient(pool, undefined, {
      execute: remote,
      getAllStatuses: () => ({ 'account-1': 'connecting' }),
      getStatus: () => 'connecting',
      isEnabled: () => true,
    });

    await client.loginWithQr('account-1', 'http://must-not-cross-command-boundary');
    await client.reconnect(
      'account-1',
      { cookie: { secret: true }, imei: 'secret-imei', userAgent: 'secret-agent' },
      'http://must-not-cross-command-boundary',
    );
    await client.disconnect('account-1');

    expect(remote).toHaveBeenNthCalledWith(1, 'loginWithQr', 'account-1', []);
    expect(remote).toHaveBeenNthCalledWith(2, 'reconnectAccount', 'account-1', []);
    expect(remote).toHaveBeenNthCalledWith(3, 'disconnectAccount', 'account-1', []);
    expect(JSON.stringify(remote.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(remote.mock.calls)).not.toContain('must-not-cross-command-boundary');
    expect(client.getStatus('account-1')).toBe('connecting');
    expect(client.getAllStatuses()).toEqual({ 'account-1': 'connecting' });
    expect(pool.loginQR).not.toHaveBeenCalled();
    expect(pool.reconnect).not.toHaveBeenCalled();
    expect(pool.disconnect).not.toHaveBeenCalled();
  });

  it('routes only allowlisted accounts through the gateway during a canary', async () => {
    const localApi = { getLabels: vi.fn().mockResolvedValue({ source: 'local' }) };
    const pool = {
      cleanupStaleGhosts: vi.fn(), disconnect: vi.fn(),
      getAllStatuses: vi.fn(() => ({ 'account-1': 'disconnected', 'account-2': 'connected' })),
      getApi: vi.fn(() => localApi), getIO: vi.fn(() => null),
      getInstance: vi.fn(() => ({ api: localApi, status: 'connected' })),
      getStatus: vi.fn(() => 'connected'), loginQR: vi.fn(), reconnect: vi.fn(), setIO: vi.fn(),
    };
    const remote = vi.fn().mockResolvedValue({ source: 'gateway' });
    const client = new ZaloProviderClient(pool, undefined, {
      execute: remote,
      getAllStatuses: () => ({ 'account-1': 'connecting', 'account-2': 'disconnected' }),
      getStatus: () => 'connecting',
      isEnabled: (accountId) => accountId === 'account-1',
    });

    await expect(client.getLabelsDirect('account-1')).resolves.toEqual({ source: 'gateway' });
    await expect(client.getLabelsDirect('account-2')).resolves.toEqual({ source: 'local' });
    expect(client.getAllStatuses()).toEqual({
      'account-1': 'connecting',
      'account-2': 'connected',
    });
    expect(remote).toHaveBeenCalledOnce();
    expect(localApi.getLabels).toHaveBeenCalledOnce();
  });
});
