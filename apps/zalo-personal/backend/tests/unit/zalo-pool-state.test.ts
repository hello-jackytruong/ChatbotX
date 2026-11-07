import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
  zaloAccount: {
    findUnique: vi.fn(),
  },
};

const stopMessageSyncMock = vi.fn();
const loggerMock = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

vi.mock('../../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('@prisma/client', () => ({ Prisma: { JsonNull: 'JSON_NULL', DbNull: 'DB_NULL' } }));
vi.mock('../../src/shared/tenant/tenant-context.js', () => ({
  runSystemQuery: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../src/shared/utils/logger.js', () => ({ logger: loggerMock }));
vi.mock('zca-js', () => ({ Zalo: class {} }));
vi.mock('../../src/modules/zalo/zalo-listener-factory.js', () => ({ attachZaloListener: vi.fn() }));
vi.mock('../../src/modules/api/webhook-service.js', () => ({ emitWebhook: vi.fn() }));
vi.mock('../../src/modules/zalo/zalo-message-sync.js', () => ({
  startMessageSync: vi.fn(),
  stopMessageSync: stopMessageSyncMock,
}));
vi.mock('../../src/modules/zalo/zalo-history-backfill.js', () => ({ backfillIfEmpty: vi.fn() }));
vi.mock('../../src/modules/zalo/proxy-util.js', () => ({
  withProxy: (_proxy: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../src/modules/zalo/status-log-service.js', () => ({ writeTransition: vi.fn() }));
vi.mock('fs/promises', () => ({ readFile: vi.fn() }));
vi.mock('image-size', () => ({ imageSize: vi.fn() }));

const { zaloPool } = await import('../../src/modules/zalo/zalo-pool.js');

type PoolInternals = {
  disconnectHistory: Map<string, number[]>;
  emitAccountEventToOrg: (
    accountId: string,
    event: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  instances: Map<string, {
    api: unknown;
    epoch: number;
    lastActivity: Date;
    orgId?: string;
    status: string;
    zalo: unknown;
  }>;
  io: unknown;
  reconnecting: Set<string>;
  stickyHoldNotificationTimers: Map<string, NodeJS.Timeout[]>;
  teardownExisting: (accountId: string) => void;
};

const pool = zaloPool as unknown as PoolInternals;

function instance(
  status: string,
  api: unknown,
  orgId?: string,
): PoolInternals['instances'] extends Map<string, infer Value> ? Value : never {
  return {
    zalo: {},
    api,
    status,
    orgId,
    lastActivity: new Date('2026-11-07T00:00:00.000Z'),
    epoch: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pool.instances.clear();
  pool.disconnectHistory.clear();
  pool.reconnecting.clear();
  for (const timers of pool.stickyHoldNotificationTimers.values()) {
    timers.forEach(clearTimeout);
  }
  pool.stickyHoldNotificationTimers.clear();
  pool.io = null;
});

describe('ZaloAccountPool IO registry and tenant-scoped events', () => {
  it('returns the exact Socket.IO server registered by setIO', () => {
    const io = { to: vi.fn() } as never;

    zaloPool.setIO(io);

    expect(zaloPool.getIO()).toBe(io);
  });

  it('emits account events only to the cached organization room', async () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    zaloPool.setIO({ to } as never);
    pool.instances.set('acc-1', instance('connected', {}, 'org-1'));

    await pool.emitAccountEventToOrg('acc-1', 'zalo:connected', { accountId: 'acc-1' });

    expect(to).toHaveBeenCalledWith('org:org-1');
    expect(emit).toHaveBeenCalledWith('zalo:connected', { accountId: 'acc-1' });
    expect(prismaMock.zaloAccount.findUnique).not.toHaveBeenCalled();
  });

  it('loads and caches orgId before emitting when the pool instance has no orgId', async () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    zaloPool.setIO({ to } as never);
    const current = instance('connected', {});
    pool.instances.set('acc-1', current);
    prismaMock.zaloAccount.findUnique.mockResolvedValue({ orgId: 'org-db' });

    await pool.emitAccountEventToOrg('acc-1', 'zalo:error', { error: 'provider down' });

    expect(prismaMock.zaloAccount.findUnique).toHaveBeenCalledWith({
      where: { id: 'acc-1' },
      select: { orgId: true },
    });
    expect(current.orgId).toBe('org-db');
    expect(to).toHaveBeenCalledWith('org:org-db');
    expect(emit).toHaveBeenCalledWith('zalo:error', { error: 'provider down' });
  });

  it('does not broadcast when Socket.IO is absent or the account has no organization', async () => {
    await pool.emitAccountEventToOrg('acc-no-io', 'zalo:error', {});
    expect(prismaMock.zaloAccount.findUnique).not.toHaveBeenCalled();

    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    zaloPool.setIO({ to } as never);
    prismaMock.zaloAccount.findUnique.mockResolvedValue(null);

    await pool.emitAccountEventToOrg('acc-missing', 'zalo:error', {});

    expect(to).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledOnce();
  });

  it('contains lookup failures instead of leaking them into connection flows', async () => {
    zaloPool.setIO({ to: vi.fn() } as never);
    prismaMock.zaloAccount.findUnique.mockRejectedValue(new Error('database unavailable'));

    await expect(pool.emitAccountEventToOrg('acc-1', 'zalo:error', {})).resolves.toBeUndefined();

    expect(loggerMock.error).toHaveBeenCalledOnce();
  });
});

describe('ZaloAccountPool state and listener lifecycle', () => {
  it('exposes statuses and only returns an API for a connected account', () => {
    const connectedApi = { sendMessage: vi.fn() };
    const disconnectedApi = { sendMessage: vi.fn() };
    const connected = instance('connected', connectedApi, 'org-1');
    const disconnected = instance('disconnected', disconnectedApi, 'org-1');
    pool.instances.set('connected-1', connected);
    pool.instances.set('disconnected-1', disconnected);

    expect(zaloPool.getStatus('connected-1')).toBe('connected');
    expect(zaloPool.getStatus('missing')).toBe('disconnected');
    expect(zaloPool.getAllStatuses()).toEqual({
      'connected-1': 'connected',
      'disconnected-1': 'disconnected',
    });
    expect(zaloPool.getApi('connected-1')).toBe(connectedApi);
    expect(zaloPool.getApi('disconnected-1')).toBeNull();
    expect(zaloPool.getApi('missing')).toBeNull();
    expect(zaloPool.getInstance('connected-1')).toBe(connected);
    expect(zaloPool.getInstance('missing')).toBeUndefined();
  });

  it('tears down an existing listener and always stops its message sync', () => {
    const stop = vi.fn();
    pool.instances.set('acc-1', instance('connected', { listener: { stop } }, 'org-1'));

    pool.teardownExisting('acc-1');

    expect(stop).toHaveBeenCalledOnce();
    expect(stopMessageSyncMock).toHaveBeenCalledWith('acc-1');
    expect(pool.instances.has('acc-1')).toBe(true);
  });

  it('contains listener stop errors during teardown and disconnect', () => {
    const stop = vi.fn(() => {
      throw new Error('listener already closed');
    });
    pool.instances.set('acc-1', instance('connected', { listener: { stop } }, 'org-1'));

    expect(() => pool.teardownExisting('acc-1')).not.toThrow();
    expect(() => zaloPool.disconnect('acc-1')).not.toThrow();

    expect(stop).toHaveBeenCalledTimes(2);
    expect(stopMessageSyncMock).toHaveBeenCalledTimes(2);
    expect(pool.instances.has('acc-1')).toBe(false);
    expect(loggerMock.warn).toHaveBeenCalledTimes(2);
  });

  it('disconnects accounts without listeners and is idempotent for missing accounts', () => {
    pool.instances.set('acc-1', instance('connecting', null, 'org-1'));

    zaloPool.disconnect('acc-1');
    zaloPool.disconnect('acc-1');

    expect(stopMessageSyncMock).toHaveBeenNthCalledWith(1, 'acc-1');
    expect(stopMessageSyncMock).toHaveBeenNthCalledWith(2, 'acc-1');
    expect(zaloPool.getStatus('acc-1')).toBe('disconnected');
  });
});
