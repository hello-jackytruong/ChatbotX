import { beforeEach, describe, expect, it, vi } from 'vitest';

const { scheduleMock, prismaMock, poolMock, loggerMock } = vi.hoisted(() => ({
  scheduleMock: vi.fn(),
  prismaMock: { zaloAccount: { findMany: vi.fn() } },
  poolMock: {
    getStatus: vi.fn(), reconnect: vi.fn(), disconnect: vi.fn(), cleanupStaleGhosts: vi.fn(),
  },
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('node-cron', () => ({ default: { schedule: scheduleMock } }));
vi.mock('@prisma/client', () => ({ Prisma: { JsonNull: 'JSON_NULL' } }));
vi.mock('../../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: poolMock }));
vi.mock('../../src/shared/utils/logger.js', () => ({ logger: loggerMock }));
vi.mock('../../src/shared/tenant/tenant-context.js', () => ({
  runSystemQuery: (fn: () => Promise<unknown>) => fn(),
}));

const { startZaloHealthCheck } = await import('../../src/modules/zalo/zalo-health-check.js');

function callbacks() {
  return new Map(scheduleMock.mock.calls.map(([expression, callback]) => [expression, callback]));
}

beforeEach(() => {
  vi.clearAllMocks();
  poolMock.reconnect.mockResolvedValue(undefined);
  poolMock.cleanupStaleGhosts.mockResolvedValue(0);
});

describe('startZaloHealthCheck', () => {
  it('registers the stable health, refresh and ghost-cleanup schedules', () => {
    startZaloHealthCheck();
    expect([...callbacks().keys()]).toEqual(['*/5 * * * *', '0 4 * * *', '0 * * * *']);
  });

  it('only reconnects passively disconnected real accounts with a usable session', async () => {
    startZaloHealthCheck();
    prismaMock.zaloAccount.findMany.mockResolvedValue([
      { id: 'connected', displayName: 'Connected', sessionData: { imei: '1' } },
      { id: 'connecting', displayName: 'Connecting', sessionData: { imei: '2' } },
      { id: 'qr', displayName: 'QR', sessionData: { imei: '3' } },
      { id: 'offline', displayName: 'Offline', sessionData: { imei: '4' } },
      { id: 'no-imei', displayName: 'No IMEI', sessionData: {} },
    ]);
    poolMock.getStatus.mockImplementation((id: string) => ({
      connected: 'connected', connecting: 'connecting', qr: 'qr_pending', offline: 'disconnected', 'no-imei': 'disconnected',
    })[id]);

    await callbacks().get('*/5 * * * *')!();

    expect(prismaMock.zaloAccount.findMany).toHaveBeenCalledWith({
      where: {
        sessionData: { not: 'JSON_NULL' }, archivedAt: null, zaloUid: { not: null },
        NOT: { disconnectReason: 'manual' },
      },
      select: { id: true, displayName: true, sessionData: true },
    });
    expect(poolMock.reconnect).toHaveBeenCalledTimes(1);
    expect(poolMock.reconnect).toHaveBeenCalledWith('offline', { imei: '4' });
  });

  it('logs and contains health-query and reconnect failures', async () => {
    startZaloHealthCheck();
    const queryError = new Error('db down');
    prismaMock.zaloAccount.findMany.mockRejectedValueOnce(queryError);
    await callbacks().get('*/5 * * * *')!();
    expect(loggerMock.error).toHaveBeenCalledWith('[health-check] Error during health check:', queryError);

    prismaMock.zaloAccount.findMany.mockResolvedValueOnce([
      { id: 'offline', displayName: 'Offline', sessionData: { imei: '4' } },
    ]);
    poolMock.getStatus.mockReturnValue('disconnected');
    const reconnectError = new Error('provider down');
    poolMock.reconnect.mockRejectedValueOnce(reconnectError);
    await callbacks().get('*/5 * * * *')!();
    await Promise.resolve();
    expect(loggerMock.warn).toHaveBeenCalledWith('[health-check] Reconnect failed for offline:', reconnectError);
  });

  it('daily refresh disconnects and reconnects sequentially with existing timing', async () => {
    vi.useFakeTimers();
    try {
      startZaloHealthCheck();
      prismaMock.zaloAccount.findMany.mockResolvedValue([
        { id: 'za-1', sessionData: { imei: 'one' } },
        { id: 'za-2', sessionData: { imei: 'two' } },
      ]);
      const run = callbacks().get('0 4 * * *')!;
      const promise = run();
      await vi.runAllTimersAsync();
      await promise;
      expect(poolMock.disconnect.mock.calls).toEqual([['za-1'], ['za-2']]);
      expect(poolMock.reconnect.mock.calls).toEqual([
        ['za-1', { imei: 'one' }], ['za-2', { imei: 'two' }],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs hourly stale-ghost cleanup at the locked 24-hour threshold', async () => {
    startZaloHealthCheck();
    poolMock.cleanupStaleGhosts.mockResolvedValue(2);
    await callbacks().get('0 * * * *')!();
    expect(poolMock.cleanupStaleGhosts).toHaveBeenCalledWith(1_440);
    expect(loggerMock.info).toHaveBeenCalledWith('[health-check] dọn 2 thẻ ma qr_pending cũ');
  });
});
