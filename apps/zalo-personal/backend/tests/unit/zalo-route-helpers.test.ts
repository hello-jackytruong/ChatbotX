import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, loggerMock } = vi.hoisted(() => ({
  prismaMock: {
    zaloAccount: { findFirst: vi.fn(), findMany: vi.fn() },
    zaloAccountAccess: { findFirst: vi.fn(), findMany: vi.fn() },
  },
  loggerMock: { error: vi.fn() },
}));

class TestZaloOpError extends Error {
  constructor(message: string, public code: string, public statusCode: number) {
    super(message);
  }
}

vi.mock('../../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../../src/shared/utils/logger.js', () => ({ logger: loggerMock }));
vi.mock('../../src/shared/zalo-operations.js', () => ({ ZaloOpError: TestZaloOpError }));

const { checkAccess, getAccessibleZaloAccountIds, handleError, resolveAccount } =
  await import('../../src/modules/zalo/zalo-route-helpers.js');

function replyMock() {
  const reply: any = {
    status: vi.fn(() => reply),
    send: vi.fn(() => reply),
  };
  return reply;
}

beforeEach(() => vi.clearAllMocks());

describe('resolveAccount', () => {
  it('scopes account lookup to id and organization', async () => {
    prismaMock.zaloAccount.findFirst.mockResolvedValue({ id: 'za-1', orgId: 'org-1' });
    await expect(resolveAccount('za-1', 'org-1')).resolves.toMatchObject({ id: 'za-1' });
    expect(prismaMock.zaloAccount.findFirst).toHaveBeenCalledWith({ where: { id: 'za-1', orgId: 'org-1' } });
  });

  it('throws the stable 404 provider error when the scoped account is absent', async () => {
    prismaMock.zaloAccount.findFirst.mockResolvedValue(null);
    await expect(resolveAccount('foreign', 'org-1')).rejects.toMatchObject({
      message: 'Account not found', code: 'INVALID_PARAMS', statusCode: 404,
    });
  });
});

describe('checkAccess', () => {
  it.each(['owner', 'admin'])('lets organization role %s bypass ACL lookup', async (role) => {
    const reply = replyMock();
    await expect(checkAccess({ user: { id: 'u1', role } } as any, reply, 'za-1', 'admin')).resolves.toBe(true);
    expect(prismaMock.zaloAccountAccess.findFirst).not.toHaveBeenCalled();
  });

  it('distinguishes no grant from an insufficient grant', async () => {
    const request = { user: { id: 'u1', role: 'member' } } as any;
    const noGrantReply = replyMock();
    prismaMock.zaloAccountAccess.findFirst.mockResolvedValueOnce(null);
    await expect(checkAccess(request, noGrantReply, 'za-1', 'read')).resolves.toBe(false);
    expect(noGrantReply.status).toHaveBeenCalledWith(403);
    expect(noGrantReply.send).toHaveBeenCalledWith({ error: 'Không có quyền truy cập tài khoản Zalo này' });

    const insufficientReply = replyMock();
    prismaMock.zaloAccountAccess.findFirst.mockResolvedValueOnce({ permission: 'read' });
    await expect(checkAccess(request, insufficientReply, 'za-1', 'chat')).resolves.toBe(false);
    expect(insufficientReply.send).toHaveBeenCalledWith({ error: 'Không đủ quyền' });
  });

  it.each([
    ['read', 'read'], ['chat', 'read'], ['chat', 'chat'], ['admin', 'admin'],
  ] as const)('allows %s permission for %s operations', async (permission, minimum) => {
    prismaMock.zaloAccountAccess.findFirst.mockResolvedValue({ permission });
    const reply = replyMock();
    await expect(checkAccess({ user: { id: 'u1', role: 'member' } } as any, reply, 'za-1', minimum)).resolves.toBe(true);
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('maps ACL storage failures to the stable 500 envelope', async () => {
    prismaMock.zaloAccountAccess.findFirst.mockRejectedValue(new Error('db down'));
    const reply = replyMock();
    await expect(checkAccess({ user: { id: 'u1', role: 'member' } } as any, reply, 'za-1', 'read')).resolves.toBe(false);
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Internal error checking access' });
  });
});

describe('getAccessibleZaloAccountIds', () => {
  it('returns every organization account for owner/admin roles', async () => {
    prismaMock.zaloAccount.findMany.mockResolvedValue([{ id: 'za-1' }, { id: 'za-2' }]);
    await expect(getAccessibleZaloAccountIds({ id: 'u1', orgId: 'org-1', role: 'admin' }))
      .resolves.toEqual(['za-1', 'za-2']);
    expect(prismaMock.zaloAccount.findMany).toHaveBeenCalledWith({ where: { orgId: 'org-1' }, select: { id: true } });
  });

  it('returns a deterministic de-duplicated union of explicit and owned accounts', async () => {
    prismaMock.zaloAccountAccess.findMany.mockResolvedValue([{ zaloAccountId: 'za-1' }, { zaloAccountId: 'za-2' }]);
    prismaMock.zaloAccount.findMany.mockResolvedValue([{ id: 'za-2' }, { id: 'za-3' }]);
    await expect(getAccessibleZaloAccountIds({ id: 'u1', orgId: 'org-1', role: 'member' }))
      .resolves.toEqual(['za-1', 'za-2', 'za-3']);
  });
});

describe('handleError', () => {
  it('preserves provider status, code and message', () => {
    const reply = replyMock();
    handleError(reply, new TestZaloOpError('rate limited', 'RATE_LIMIT', 429), 'send');
    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith({ error: 'rate limited', code: 'RATE_LIMIT' });
  });

  it('hides unknown errors and logs them with operation context', () => {
    const reply = replyMock();
    const error = new Error('database secret');
    handleError(reply, error, 'sync');
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Internal server error' });
    expect(loggerMock.error).toHaveBeenCalledWith('[zalo-routes] sync failed:', error);
  });
});
