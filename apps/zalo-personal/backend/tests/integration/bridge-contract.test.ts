import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { GatewayCommandRepository } from '../../src/modules/gateway/command-repository.js';
import { createBridgeRoutes } from '../../src/modules/bridge/routes.js';

describe('bridge v1 HTTP contract', () => {
  it('provisions one account-scoped bridge client for an idempotent ChatbotX session', async () => {
    const app = Fastify();
    const provision = vi.fn().mockResolvedValue({
      accountId: 'account-1',
      keyId: 'account-client-1',
      secret: 'account-secret-1',
    });
    const verify = vi.fn().mockResolvedValue({
      kid: 'provisioner-1',
      secret: 'provisioner-secret',
      accountIds: [],
      active: true,
      provisioningScope: { orgId: 'org-1', ownerUserId: 'user-1' },
    });
    await app.register(createBridgeRoutes({
      auth: { verify },
      bindings: { bind: vi.fn() },
      commands: new GatewayCommandRepository(),
      events: { list: vi.fn().mockResolvedValue([]) },
      onboarding: { provision },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/internal/bridge/v1/onboarding',
      headers: {
        'x-bridge-kid': 'provisioner-1',
        'x-bridge-timestamp': '1794096000',
        'x-bridge-nonce': 'onboarding-nonce',
        'x-bridge-signature': 'a'.repeat(64),
      },
      payload: {
        version: 1,
        workspaceId: 'workspace-1',
        connectSessionId: 'session-1',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      version: 1,
      accountId: 'account-1',
      keyId: 'account-client-1',
      secret: 'account-secret-1',
    });
    expect(provision).toHaveBeenCalledWith({
      connectSessionId: 'session-1',
      orgId: 'org-1',
      ownerUserId: 'user-1',
      workspaceId: 'workspace-1',
    });
  });

  it('denies onboarding to an account-scoped bridge client', async () => {
    const app = Fastify();
    const provision = vi.fn();
    await app.register(createBridgeRoutes({
      auth: { verify: vi.fn().mockResolvedValue({
        kid: 'client-1', secret: 'synthetic', accountIds: ['account-1'], active: true,
      }) },
      bindings: { bind: vi.fn() },
      commands: new GatewayCommandRepository(),
      events: { list: vi.fn().mockResolvedValue([]) },
      onboarding: { provision },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/internal/bridge/v1/onboarding',
      headers: {
        'x-bridge-kid': 'client-1',
        'x-bridge-timestamp': '1794096000',
        'x-bridge-nonce': 'onboarding-denied',
        'x-bridge-signature': 'a'.repeat(64),
      },
      payload: { version: 1, workspaceId: 'workspace-1', connectSessionId: 'session-1' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'PROVISIONING_SCOPE_DENIED' });
    expect(provision).not.toHaveBeenCalled();
  });

  it('accepts idempotent commands, returns status and exposes ordered event pages', async () => {
    const app = Fastify();
    const commands = new GatewayCommandRepository();
    const verify = vi.fn().mockResolvedValue({
      kid: 'client-1', secret: 'redacted', accountIds: ['account-1'], active: true,
    });
    await app.register(createBridgeRoutes({
      auth: { verify },
      bindings: { bind: vi.fn().mockResolvedValue('bound') },
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
    expect(accepted.headers['x-bridge-correlation-id']).toBe('nonce-1');
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
      bindings: { bind: vi.fn().mockResolvedValue('bound') },
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
      bindings: { bind: vi.fn() },
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

  it('health-checks the provisioned account and binds its ChatbotX inbox idempotently', async () => {
    const app = Fastify();
    const verify = vi.fn().mockResolvedValue({
      kid: 'client-1', secret: 'synthetic', accountIds: ['account-1'], active: true,
    });
    const bind = vi.fn().mockResolvedValue('bound');
    await app.register(createBridgeRoutes({
      auth: { verify },
      bindings: { bind },
      commands: new GatewayCommandRepository(),
      events: { list: vi.fn().mockResolvedValue([]) },
    }));
    const headers = {
      'x-bridge-kid': 'client-1', 'x-bridge-timestamp': '1794096000',
      'x-bridge-nonce': 'nonce-health', 'x-bridge-signature': 'a'.repeat(64),
    };

    const health = await app.inject({
      method: 'GET',
      url: '/internal/bridge/v1/accounts/account-1/health',
      headers,
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ version: 1, ready: true, accountId: 'account-1' });
    expect(verify).toHaveBeenLastCalledWith(expect.any(Object), 'account-1');

    const binding = await app.inject({
      method: 'PUT',
      url: '/internal/bridge/v1/accounts/account-1/binding',
      headers: { ...headers, 'x-bridge-nonce': 'nonce-binding' },
      payload: { version: 1, workspaceId: 'workspace-1', inboxId: 'inbox-1' },
    });
    expect(binding.statusCode).toBe(200);
    expect(binding.json()).toEqual({
      version: 1,
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      inboxId: 'inbox-1',
      status: 'bound',
    });
    expect(bind).toHaveBeenCalledWith({
      kid: 'client-1',
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      inboxId: 'inbox-1',
    });
  });

  it('retires only the authenticated ChatbotX-managed onboarding account', async () => {
    const app = Fastify();
    const cleanup = vi.fn().mockResolvedValue('cleaned');
    const verify = vi.fn().mockResolvedValue({
      kid: 'client-1', secret: 'synthetic', accountIds: ['account-1'], active: true,
    });
    await app.register(createBridgeRoutes({
      auth: { verify },
      bindings: { bind: vi.fn() },
      commands: new GatewayCommandRepository(),
      events: { list: vi.fn().mockResolvedValue([]) },
      onboarding: { provision: vi.fn(), cleanup },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/internal/bridge/v1/accounts/account-1/onboarding-cleanup',
      headers: {
        'x-bridge-kid': 'client-1', 'x-bridge-timestamp': '1794096000',
        'x-bridge-nonce': 'nonce-cleanup', 'x-bridge-signature': 'a'.repeat(64),
      },
      payload: { version: 1, connectSessionId: 'session-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      version: 1,
      accountId: 'account-1',
      status: 'cleaned',
    });
    expect(verify).toHaveBeenCalledWith(
      expect.any(Object),
      'account-1',
      { allowRevokedForOnboardingCleanup: true },
    );
    expect(cleanup).toHaveBeenCalledWith({
      accountId: 'account-1',
      kid: 'client-1',
      connectSessionId: 'session-1',
    });
  });

  it('fails closed when the provisioned account is bound to another workspace or inbox', async () => {
    const app = Fastify();
    await app.register(createBridgeRoutes({
      auth: { verify: vi.fn().mockResolvedValue({
        kid: 'client-1', secret: 'synthetic', accountIds: ['account-1'], active: true,
      }) },
      bindings: { bind: vi.fn().mockResolvedValue('conflict') },
      commands: new GatewayCommandRepository(),
      events: { list: vi.fn().mockResolvedValue([]) },
    }));
    const response = await app.inject({
      method: 'PUT',
      url: '/internal/bridge/v1/accounts/account-1/binding',
      headers: {
        'x-bridge-kid': 'client-1', 'x-bridge-timestamp': '1794096000',
        'x-bridge-nonce': 'nonce-conflict', 'x-bridge-signature': 'a'.repeat(64),
      },
      payload: { version: 1, workspaceId: 'workspace-2', inboxId: 'inbox-2' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'BRIDGE_ACCOUNT_BINDING_CONFLICT' });
  });
});
