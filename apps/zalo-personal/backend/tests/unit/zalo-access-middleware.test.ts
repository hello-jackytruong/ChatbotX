import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  zaloAccount: { findFirst: vi.fn() },
  zaloAccountAccess: { findFirst: vi.fn() },
  conversation: { findFirst: vi.fn() },
}));
vi.mock('../../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));

const { checkZaloAccess, hasZaloAccess, requireZaloAccess } =
  await import('../../src/modules/zalo/zalo-access-middleware.js');

const base = {
  userId: 'user-1', orgId: 'org-1', role: 'member', zaloAccountId: 'za-1', minPermission: 'chat' as const,
};

function replyMock() {
  const reply: any = { status: vi.fn(() => reply), send: vi.fn(() => reply) };
  return reply;
}

beforeEach(() => vi.clearAllMocks());

describe('checkZaloAccess', () => {
  it.each(['owner', 'admin'])('grants organization role %s without database work', async (role) => {
    await expect(checkZaloAccess({ ...base, role })).resolves.toBe('ok');
    expect(prismaMock.zaloAccount.findFirst).not.toHaveBeenCalled();
  });

  it('grants the account owner even when their organization role is member', async () => {
    prismaMock.zaloAccount.findFirst.mockResolvedValue({ ownerUserId: 'user-1' });
    await expect(checkZaloAccess(base)).resolves.toBe('ok');
    expect(prismaMock.zaloAccountAccess.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    [null, 'no_grant'],
    [{ permission: 'read' }, 'insufficient'],
    [{ permission: 'chat' }, 'ok'],
    [{ permission: 'admin' }, 'ok'],
    [{ permission: 'unknown' }, 'insufficient'],
  ] as const)('maps ACL %j to %s', async (access, expected) => {
    prismaMock.zaloAccount.findFirst.mockResolvedValue({ ownerUserId: 'someone-else' });
    prismaMock.zaloAccountAccess.findFirst.mockResolvedValue(access);
    await expect(checkZaloAccess(base)).resolves.toBe(expected);
  });

  it('keeps the boolean helper identical to the decision result', async () => {
    prismaMock.zaloAccount.findFirst.mockResolvedValue({ ownerUserId: 'someone-else' });
    prismaMock.zaloAccountAccess.findFirst.mockResolvedValue({ permission: 'chat' });
    await expect(hasZaloAccess(base)).resolves.toBe(true);
    prismaMock.zaloAccountAccess.findFirst.mockResolvedValue(null);
    await expect(hasZaloAccess(base)).resolves.toBe(false);
  });
});

describe('requireZaloAccess', () => {
  it('resolves a conversation id to its Zalo account before checking access', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue({ zaloAccountId: 'za-from-conversation' });
    prismaMock.zaloAccount.findFirst.mockResolvedValue({ ownerUserId: 'user-1' });
    const reply = replyMock();
    const handler = requireZaloAccess('chat');
    await handler({ user: { id: 'user-1', orgId: 'org-1', role: 'member' }, params: { id: 'conv-1' } } as any, reply);
    expect(prismaMock.conversation.findFirst).toHaveBeenCalledWith({
      where: { id: 'conv-1', orgId: 'org-1' }, select: { zaloAccountId: true },
    });
    expect(prismaMock.zaloAccount.findFirst).toHaveBeenCalledWith({
      where: { id: 'za-from-conversation', orgId: 'org-1' }, select: { ownerUserId: true },
    });
    expect(reply.send).not.toHaveBeenCalled();
  });

  it.each([
    [null, 'Không có quyền truy cập tài khoản Zalo này'],
    [{ permission: 'read' }, 'Không đủ quyền'],
  ] as const)('preserves the two distinct 403 envelopes', async (access, message) => {
    prismaMock.zaloAccount.findFirst.mockResolvedValue({ ownerUserId: 'someone-else' });
    prismaMock.zaloAccountAccess.findFirst.mockResolvedValue(access);
    const reply = replyMock();
    await requireZaloAccess('chat')(
      { user: { id: 'user-1', orgId: 'org-1', role: 'member' }, params: { zaloAccountId: 'za-1' } } as any,
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: message });
  });

  it('returns 404 when neither account nor conversation resolves an account id', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue(null);
    const reply = replyMock();
    await requireZaloAccess('read')(
      { user: { id: 'user-1', orgId: 'org-1', role: 'member' }, params: {} } as any,
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Not found' });
  });

  it('maps conversation and access storage failures to the same stable 500 envelope', async () => {
    prismaMock.conversation.findFirst.mockRejectedValueOnce(new Error('db down'));
    const conversationReply = replyMock();
    await requireZaloAccess('read')(
      { user: { id: 'user-1', orgId: 'org-1', role: 'member' }, params: { id: 'conv-1' } } as any,
      conversationReply,
    );
    expect(conversationReply.send).toHaveBeenCalledWith({ error: 'Internal error checking access' });

    prismaMock.zaloAccount.findFirst.mockRejectedValueOnce(new Error('db down'));
    const accessReply = replyMock();
    await requireZaloAccess('read')(
      { user: { id: 'user-1', orgId: 'org-1', role: 'member' }, params: { zaloAccountId: 'za-1' } } as any,
      accessReply,
    );
    expect(accessReply.status).toHaveBeenCalledWith(500);
    expect(accessReply.send).toHaveBeenCalledWith({ error: 'Internal error checking access' });
  });
});
