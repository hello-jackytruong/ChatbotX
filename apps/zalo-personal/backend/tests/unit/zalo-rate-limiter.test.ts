import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getRedisMock, getEffectiveLimitMock } = vi.hoisted(() => ({
  getRedisMock: vi.fn(),
  getEffectiveLimitMock: vi.fn(),
}));

vi.mock('../../src/shared/redis-client.js', () => ({
  getRedis: getRedisMock,
}));

const fallbackLimits = {
  message: { daily: 2, burst: 2, burstWindowMs: 1_000 },
  friend_request: { daily: 3, burst: 1, burstWindowMs: 2_000 },
};
vi.mock('../../src/modules/zalo/sdk-limit-service.js', () => ({
  getEffectiveLimit: getEffectiveLimitMock,
  ALL_CATEGORIES: ['message', 'friend_request'],
  DEFAULT_SDK_LIMITS: fallbackLimits,
}));

async function loadLimiter() {
  vi.resetModules();
  return (await import('../../src/modules/zalo/zalo-rate-limiter.js')).zaloRateLimiter;
}

function redisMock() {
  return {
    hget: vi.fn(),
    hincrby: vi.fn(),
    expire: vi.fn(),
    zremrangebyscore: vi.fn(),
    zcard: vi.fn(),
    zadd: vi.fn(),
    pexpire: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-07T05:00:00.000Z'));
  getRedisMock.mockReset().mockResolvedValue(null);
  getEffectiveLimitMock.mockReset().mockResolvedValue({ daily: 2, burst: 2, burstWindowMs: 1_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('zaloRateLimiter memory contract', () => {
  it('blocks at the configured daily limit and resets on the next UTC date', async () => {
    const limiter = await loadLimiter();
    await limiter.recordSend('account-1', 'message');
    await limiter.recordSend('account-1', 'message');

    await expect(limiter.checkLimits('account-1', 'message')).resolves.toEqual({
      allowed: false,
      reason: 'Đã đạt giới hạn 2 message/ngày',
    });

    vi.setSystemTime(new Date('2026-11-08T05:00:00.000Z'));
    await expect(limiter.checkLimits('account-1', 'message')).resolves.toEqual({ allowed: true });
    await expect(limiter.getDailyCount('account-1', 'message')).resolves.toBe(0);
  });

  it('blocks a burst independently per account and category', async () => {
    getEffectiveLimitMock.mockResolvedValue({ daily: 100, burst: 2, burstWindowMs: 1_000 });
    const limiter = await loadLimiter();
    await limiter.recordSend('account-1', 'message');
    await limiter.recordSend('account-1', 'message');

    await expect(limiter.checkLimits('account-1', 'message')).resolves.toEqual({
      allowed: false,
      reason: 'Quá nhanh (>2 message/1s)',
    });
    await expect(limiter.checkLimits('account-2', 'message')).resolves.toEqual({ allowed: true });
    await expect(limiter.checkLimits('account-1', 'friend_request')).resolves.toEqual({ allowed: true });
  });

  it('fails open when limit lookup fails', async () => {
    getEffectiveLimitMock.mockRejectedValue(new Error('database unavailable'));
    const limiter = await loadLimiter();
    await expect(limiter.checkLimits('account-1', 'message')).resolves.toEqual({ allowed: true });
  });

  it('returns all category counters and a defensive copy of fallback limits', async () => {
    const limiter = await loadLimiter();
    await limiter.recordSend('account-1', 'message');
    await expect(limiter.getAllDailyCounts('account-1')).resolves.toEqual({ message: 1, friend_request: 0 });

    const first = limiter.getLimitsConfig();
    delete first.message;
    expect(limiter.getLimitsConfig()).toEqual(fallbackLimits);
  });
});

describe('zaloRateLimiter Redis contract', () => {
  it('uses daily and sorted-set counters with exact key and expiry contracts', async () => {
    const redis = redisMock();
    getRedisMock.mockResolvedValue(redis);
    redis.hget.mockResolvedValue('0');
    redis.zcard.mockResolvedValue(0);
    const limiter = await loadLimiter();

    await expect(limiter.checkLimits('account-1', 'message')).resolves.toEqual({ allowed: true });
    expect(redis.hget).toHaveBeenCalledWith('rl:daily:account-1:message', '2026-11-07');
    expect(redis.zremrangebyscore).toHaveBeenCalledWith('rl:burst:account-1:message', '-inf', String(Date.now() - 1_000));
    expect(redis.zcard).toHaveBeenCalledWith('rl:burst:account-1:message');

    await limiter.recordSend('account-1', 'message');
    expect(redis.hincrby).toHaveBeenCalledWith('rl:daily:account-1:message', '2026-11-07', 1);
    expect(redis.expire).toHaveBeenCalledWith('rl:daily:account-1:message', 172_800);
    expect(redis.zadd).toHaveBeenCalledWith('rl:burst:account-1:message', String(Date.now()), String(Date.now()));
    expect(redis.pexpire).toHaveBeenCalledWith('rl:burst:account-1:message', 120_000);
  });

  it('falls back to memory when recording in Redis fails', async () => {
    const redis = redisMock();
    getRedisMock.mockResolvedValue(redis);
    redis.hincrby.mockRejectedValue(new Error('redis down'));
    const limiter = await loadLimiter();

    await limiter.recordSend('account-1', 'message');
    redis.hget.mockRejectedValue(new Error('redis still down'));
    await expect(limiter.getDailyCount('account-1', 'message')).resolves.toBe(1);
  });

  it('records operation metrics best-effort and normalizes missing or invalid reads to zero', async () => {
    const redis = redisMock();
    getRedisMock.mockResolvedValue(redis);
    const limiter = await loadLimiter();

    await limiter.recordOperation('account-1', 'getAllFriends');
    expect(redis.hincrby).toHaveBeenCalledWith('rl:op:account-1:getAllFriends', '2026-11-07', 1);
    expect(redis.expire).toHaveBeenCalledWith('rl:op:account-1:getAllFriends', 777_600);

    redis.hget.mockResolvedValueOnce('7').mockRejectedValueOnce(new Error('redis down'));
    await expect(limiter.getOperationCount('account-1', 'getAllFriends')).resolves.toBe(7);
    await expect(limiter.getOperationCount('account-1', 'getAllFriends')).resolves.toBe(0);
  });
});
