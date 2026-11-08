import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareLegacyScenario } from './legacy-differential-harness.js';

const { loggerMock, poolMock, prismaMock, rateLimiterMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  poolMock: {
    getInstance: vi.fn(),
    reconnect: vi.fn(),
  },
  prismaMock: {
    zaloAccount: { findUnique: vi.fn() },
  },
  rateLimiterMock: {
    checkLimits: vi.fn(),
    recordSend: vi.fn(),
  },
}));

vi.mock('../../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: poolMock }));
vi.mock('../../src/modules/zalo/zalo-rate-limiter.js', () => ({ zaloRateLimiter: rateLimiterMock }));
vi.mock('../../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../../src/shared/utils/logger.js', () => ({ logger: loggerMock }));

const { ZaloOpError, zaloOps } = await import('../../src/shared/zalo-operations.js');

const fixtureRoot = path.resolve(import.meta.dirname, 'fixtures');

function readFixture(name: string) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), 'utf8'));
}

beforeEach(() => {
  vi.clearAllMocks();
  rateLimiterMock.checkLimits.mockResolvedValue({ allowed: true });
  prismaMock.zaloAccount.findUnique.mockResolvedValue({
    sessionData: { cookie: ['<redacted>'], imei: '<redacted>', userAgent: '<redacted>' },
  });
});

afterEach(() => vi.useRealTimers());

describe('Zalo provider behavior oracle', () => {
  it('locks the complete public operation surface', () => {
    const fixture = readFixture('zalo-personal-public-v1.json');
    expect(Object.keys(zaloOps).sort()).toEqual(fixture.providerOperations);
  });

  it('locks QR retry, room and event names used by the legacy pool', () => {
    const fixture = readFixture('zalo-personal-public-v1.json');
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../src/modules/zalo/zalo-pool.ts'),
      'utf8',
    );

    expect(source).toContain('const MAX_QR_RETRY = 3');
    expect(source).toContain('if (!isCurrentEpoch()) return');
    for (const event of fixture.accountEvents) {
      expect(source).toContain(`'${event}'`);
    }
    expect(source).toContain('`account:${accountId}`');
    expect(source).toContain('`org:${orgId}`');
  });

  it('preserves the send-message provider call and Socket.IO payload', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ msgId: 'provider-msg-1', cliMsgId: 'provider-cli-1' });
    poolMock.getInstance.mockReturnValue({ status: 'connected', api: { sendMessage } });
    const emit = vi.fn();
    const io = { emit, to: vi.fn() } as never;

    const result = await zaloOps.sendMessage('account-1', 'thread-1', 0, { msg: 'synthetic-message' }, io);

    expect(sendMessage).toHaveBeenCalledWith({ msg: 'synthetic-message' }, 'thread-1', 0);
    expect(rateLimiterMock.checkLimits).toHaveBeenCalledWith('account-1', 'message');
    expect(rateLimiterMock.recordSend).toHaveBeenCalledWith('account-1', 'message');
    expect(emit).toHaveBeenCalledWith('chat:message', {
      accountId: 'account-1',
      operation: 'sendMessage',
      result,
    });
  });

  it('keeps exact typed failures for disconnected and rate-limited accounts', async () => {
    const fixture = readFixture('zalo-personal-failure-v1.json');
    poolMock.getInstance.mockReturnValue({ status: 'disconnected', api: null });

    await expect(zaloOps.getOwnId('account-1')).rejects.toMatchObject(fixture.notConnected);

    poolMock.getInstance.mockReturnValue({ status: 'connected', api: { getOwnId: vi.fn() } });
    rateLimiterMock.checkLimits.mockResolvedValue({ allowed: false, reason: 'Synthetic rate limit' });
    await expect(zaloOps.getOwnId('account-1')).rejects.toMatchObject(fixture.rateLimited);
  });

  it('reconnects once on an expired session and uses the fresh API', async () => {
    const staleApi = { getOwnId: vi.fn().mockRejectedValue(new Error('session expired')) };
    const freshApi = { getOwnId: vi.fn().mockResolvedValue('zalo-user-1') };
    poolMock.getInstance
      .mockReturnValueOnce({ status: 'connected', api: staleApi })
      .mockReturnValueOnce({ status: 'connected', api: freshApi });
    poolMock.reconnect.mockResolvedValue(undefined);

    await expect(zaloOps.getOwnId('account-1')).resolves.toBe('zalo-user-1');

    expect(poolMock.reconnect).toHaveBeenCalledWith('account-1', {
      cookie: ['<redacted>'],
      imei: '<redacted>',
      userAgent: '<redacted>',
    });
    expect(staleApi.getOwnId).toHaveBeenCalledOnce();
    expect(freshApi.getOwnId).toHaveBeenCalledOnce();
  });

  it('preserves the legacy error mapping including provider error codes', async () => {
    const providerError = Object.assign(new Error('message unavailable'), { code: 222 });
    poolMock.getInstance.mockReturnValue({
      status: 'connected',
      api: { getOwnId: vi.fn().mockRejectedValue(providerError) },
    });

    await expect(zaloOps.getOwnId('account-1')).rejects.toEqual(
      expect.objectContaining<Partial<InstanceType<typeof ZaloOpError>>>({
        code: 'API_ERROR',
        message: 'getOwnId failed: message unavailable [zalo:222]',
        statusCode: 500,
      }),
    );
  });

  it('retries transient network failures with the legacy 400ms/800ms schedule', async () => {
    vi.useFakeTimers();
    const getOwnId = vi.fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('other side closed'))
      .mockResolvedValueOnce('zalo-user-1');
    poolMock.getInstance.mockReturnValue({ status: 'connected', api: { getOwnId } });

    const resultPromise = zaloOps.getOwnId('account-1');
    await vi.advanceTimersByTimeAsync(400);
    expect(getOwnId).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(800);

    await expect(resultPromise).resolves.toBe('zalo-user-1');
    expect(getOwnId).toHaveBeenCalledTimes(3);
    expect(rateLimiterMock.recordSend).toHaveBeenCalledOnce();
  });

  it('provides a differential harness that reports both traces without normalizing them', async () => {
    const scenario = { name: 'send-text', input: { threadId: 'thread-1' } };
    const legacy = vi.fn().mockResolvedValue([{ name: 'sendMessage', payload: scenario.input }]);
    const candidate = vi.fn().mockResolvedValue([{ name: 'sendMessage', payload: scenario.input }]);

    await expect(compareLegacyScenario(scenario, legacy, candidate)).resolves.toEqual({
      legacy: [{ name: 'sendMessage', payload: scenario.input }],
      candidate: [{ name: 'sendMessage', payload: scenario.input }],
    });
  });
});
