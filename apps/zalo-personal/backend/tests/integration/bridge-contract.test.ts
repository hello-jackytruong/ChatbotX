import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { GatewayCommandRepository } from '../../src/modules/gateway/command-repository.js';
import { createBridgeRoutes } from '../../src/modules/bridge/routes.js';

describe('bridge v1 HTTP contract', () => {
  it('accepts idempotent commands, returns status and exposes ordered event pages', async () => {
    const app = Fastify();
    const commands = new GatewayCommandRepository();
    const verify = vi.fn().mockResolvedValue({
      kid: 'client-1', secret: 'redacted', accountIds: ['account-1'], active: true,
    });
    await app.register(createBridgeRoutes({
      auth: { verify },
      commands,
      events: {
        list: vi.fn().mockResolvedValue([{
          eventId: 'event-1', accountId: 'account-1', accountSequence: 1n,
          fenceToken: 1n, ownerId: '', kind: 'message', payload: { sourceId: 'provider-1' },
          occurredAt: new Date('2026-11-08T00:00:00.000Z'),
          createdAt: new Date('2026-11-08T00:00:01.000Z'),
        }]),
      },
    }));

    const command = {
      version: 1,
      commandId: 'command-1',
      idempotencyKey: 'message-1',
      accountId: 'account-1',
      kind: 'sendMessage',
      payload: { args: ['thread-1', 0, { msg: 'synthetic' }] },
      requestedAt: '2026-11-08T00:00:00.000Z',
      deadlineAt: '2026-11-08T00:00:30.000Z',
      traceId: 'trace-1',
    };
    const headers = {
      'x-bridge-kid': 'client-1', 'x-bridge-timestamp': '1794096000',
      'x-bridge-nonce': 'nonce-1', 'x-bridge-signature': 'a'.repeat(64),
    };
    const accepted = await app.inject({ method: 'POST', url: '/internal/bridge/v1/commands', headers, payload: command });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ commandId: 'command-1', status: 'pending' });
    expect(accepted.headers['x-bridge-correlation-id']).toBe('command-1');
    expect(accepted.headers['x-bridge-response-signature']).toMatch(/^[a-f0-9]{64}$/);

    const status = await app.inject({
      method: 'GET', url: '/internal/bridge/v1/commands/command-1',
      headers: { ...headers, 'x-bridge-nonce': 'nonce-2' },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ commandId: 'command-1', status: 'pending' });

    const events = await app.inject({
      method: 'GET', url: '/internal/bridge/v1/accounts/account-1/events?after=0&limit=10',
      headers: { ...headers, 'x-bridge-nonce': 'nonce-3' },
    });
    expect(events.statusCode).toBe(200);
    expect(events.json()).toMatchObject({
      accountId: 'account-1', nextSequence: '1', highWaterMark: '1', retentionFloor: '1',
      events: [{ eventId: 'event-1', accountSequence: '1', kind: 'message' }],
    });
  });

  it('rejects a conflicting idempotency payload with 409', async () => {
    const app = Fastify();
    const commands = new GatewayCommandRepository();
    await app.register(createBridgeRoutes({
      auth: { verify: vi.fn().mockResolvedValue({
        kid: 'client-1', secret: 'synthetic', accountIds: ['account-1'], active: true,
      }) },
      commands,
      events: { list: vi.fn().mockResolvedValue([]) },
    }));
    const base = {
      version: 1, commandId: 'command-1', idempotencyKey: 'same', accountId: 'account-1',
      kind: 'sendMessage', requestedAt: '2026-11-08T00:00:00.000Z',
      deadlineAt: '2026-11-08T00:00:30.000Z', traceId: 'trace-1',
    };
    const headers = {
      'x-bridge-kid': 'client-1', 'x-bridge-timestamp': '1794096000',
      'x-bridge-nonce': 'nonce-1', 'x-bridge-signature': 'a'.repeat(64),
    };
    await app.inject({ method: 'POST', url: '/internal/bridge/v1/commands', headers, payload: { ...base, payload: { args: ['a'] } } });
    const conflict = await app.inject({
      method: 'POST', url: '/internal/bridge/v1/commands',
      headers: { ...headers, 'x-bridge-nonce': 'nonce-2' },
      payload: { ...base, commandId: 'command-2', payload: { args: ['different'] } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects an unknown major contract version with 426', async () => {
    const app = Fastify();
    await app.register(createBridgeRoutes({
      auth: { verify: vi.fn() },
      commands: new GatewayCommandRepository(),
      events: { list: vi.fn().mockResolvedValue([]) },
    }));
    const response = await app.inject({
      method: 'POST', url: '/internal/bridge/v1/commands',
      payload: { version: 2 },
    });
    expect(response.statusCode).toBe(426);
    expect(response.json()).toEqual({ error: 'UNSUPPORTED_BRIDGE_VERSION', supported: [1] });
  });
});
