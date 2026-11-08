import { describe, expect, it, vi } from 'vitest';
import { GatewayCommandRepository } from '../../src/modules/gateway/command-repository.js';
import { GatewayCommandRunner } from '../../src/modules/gateway/command-runner.js';
import { GatewayCredentialStore } from '../../src/modules/gateway/credential-store.js';

describe('gateway command crash recovery', () => {
  it('reclaims an expired claim with the same identity and never accepts a conflicting payload', async () => {
    const repository = new GatewayCommandRepository(() => 1_000);
    const created = await repository.insert({
      commandId: 'command-1', accountId: 'account-1', idempotencyKey: 'echo-1',
      kind: 'sendMessage', version: 1, payload: { args: ['thread-1', 0, { msg: 'synthetic' }] },
    });
    expect(created.created).toBe(true);
    await expect(repository.insert({
      commandId: 'command-2', accountId: 'account-1', idempotencyKey: 'echo-1',
      kind: 'sendMessage', version: 1, payload: { args: ['thread-1', 0, { msg: 'different' }] },
    })).rejects.toThrow('IDEMPOTENCY_CONFLICT');

    const first = await repository.claim('gateway-a', 100, 1);
    expect(first[0]).toMatchObject({ commandId: 'command-1', attempts: 1 });
    repository.advanceTo(1_101);
    const reclaimed = await repository.claim('gateway-b', 100, 1);
    expect(reclaimed[0]).toMatchObject({ commandId: 'command-1', attempts: 2, leaseOwner: 'gateway-b' });

    await repository.complete('command-1', 'gateway-b', {
      status: 'unknown_outcome', result: null, error: 'provider accepted; result lost',
    });
    expect(await repository.get('command-1')).toMatchObject({
      commandId: 'command-1', idempotencyKey: 'echo-1', status: 'unknown_outcome', attempts: 2,
    });
  });

  it('prefers authenticated ciphertext, falls back only when ciphertext is absent, and fails closed on tamper', async () => {
    const rows = new Map<string, any>();
    const repository = {
      read: async (accountId: string) => rows.get(accountId) ?? null,
      write: async (accountId: string, data: Record<string, unknown>) => {
        rows.set(accountId, { ...(rows.get(accountId) ?? {}), ...data });
      },
    };
    const key = '11'.repeat(32);
    const store = new GatewayCredentialStore(repository, key);
    const session = { cookie: [{ key: 'synthetic' }], imei: 'imei-1', userAgent: 'ua-1' };

    await store.dualWrite('account-1', session, 'http://synthetic-proxy');
    await expect(store.read('account-1')).resolves.toEqual({ session, proxyUrl: 'http://synthetic-proxy' });

    const encrypted = rows.get('account-1');
    rows.set('mixed-rollout', {
      ...encrypted,
      proxyCiphertext: null,
      proxyUrl: 'http://legacy-proxy',
    });
    await expect(store.read('mixed-rollout')).resolves.toEqual({
      session,
      proxyUrl: 'http://legacy-proxy',
    });
    rows.set('legacy', { sessionData: session, proxyUrl: null, sessionCiphertext: null, proxyCiphertext: null });
    await expect(store.read('legacy')).resolves.toEqual({ session, proxyUrl: null });

    const ciphertext = String(encrypted.sessionCiphertext);
    const parts = ciphertext.split(':');
    parts[2] = `${parts[2].startsWith('A') ? 'B' : 'A'}${parts[2].slice(1)}`;
    rows.set('account-1', {
      ...encrypted,
      sessionCiphertext: parts.join(':'),
    });
    await expect(store.read('account-1')).rejects.toThrow();
  });

  it('does not blindly repeat a mutating provider call after its processing lease expires', async () => {
    const repository = new GatewayCommandRepository(() => 2_000);
    await repository.insert({
      commandId: 'command-send', accountId: 'account-1', idempotencyKey: 'echo-send',
      kind: 'sendMessage', version: 1, payload: { args: ['thread-1', 0, { msg: 'synthetic' }] },
    });
    await repository.claim('crashed-gateway', 100, 1);
    repository.advanceTo(2_101);
    const execute = vi.fn();
    const runner = new GatewayCommandRunner('replacement-gateway', repository, { execute }, 100, 1);

    await expect(runner.runOnce()).resolves.toBe(1);
    expect(execute).not.toHaveBeenCalled();
    await expect(repository.get('command-send')).resolves.toMatchObject({
      status: 'unknown_outcome',
      attempts: 2,
    });
    await expect(repository.reconcile({
      accountId: 'account-1',
      idempotencyKey: 'echo-send',
    })).resolves.toMatchObject({ commandId: 'command-send', status: 'unknown_outcome' });
  });
});
