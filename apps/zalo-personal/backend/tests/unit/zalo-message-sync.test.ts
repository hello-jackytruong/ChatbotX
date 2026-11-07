import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, handleIncomingMessageMock, loggerMock } = vi.hoisted(() => ({
  prismaMock: {
    zaloAccount: { findUnique: vi.fn() },
    conversation: { findMany: vi.fn() },
    message: { findMany: vi.fn() },
  },
  handleIncomingMessageMock: vi.fn(),
  loggerMock: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../../src/shared/utils/logger.js', () => ({ logger: loggerMock }));
vi.mock('../../src/modules/chat/message-handler.js', () => ({ handleIncomingMessage: handleIncomingMessageMock }));
vi.mock('../../src/modules/zalo/zalo-message-helpers.js', () => ({
  detectContentType: vi.fn(() => 'text'),
  extractAlbumInfo: vi.fn(() => ({ albumKey: null, albumIndex: null, albumTotal: null })),
}));
vi.mock('../../src/shared/tenant/tenant-context.js', () => ({
  runSystemQuery: (fn: () => Promise<unknown>) => fn(),
  withTenant: (_orgId: string, fn: () => Promise<unknown>) => fn(),
}));

async function loadModule() {
  vi.resetModules();
  return import('../../src/modules/zalo/zalo-message-sync.js');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-07T05:00:00.000Z'));
  vi.clearAllMocks();
  prismaMock.zaloAccount.findUnique.mockResolvedValue({ orgId: 'org-1' });
  prismaMock.conversation.findMany.mockResolvedValue([]);
  prismaMock.message.findMany.mockResolvedValue([]);
  handleIncomingMessageMock.mockResolvedValue({ id: 'created' });
});

afterEach(() => vi.useRealTimers());

describe('Zalo group message polling backup', () => {
  it('starts exactly one five-minute interval per account and stop removes it', async () => {
    const { startMessageSync, stopMessageSync } = await loadModule();
    const api = { getGroupChatHistory: vi.fn() };
    startMessageSync(api, 'za-1');
    startMessageSync(api, 'za-1');
    expect(vi.getTimerCount()).toBe(1);
    expect(loggerMock.info).toHaveBeenCalledWith('[sync:za-1] Started group message sync (every 300s)');

    stopMessageSync('za-1');
    expect(vi.getTimerCount()).toBe(0);
    expect(loggerMock.info).toHaveBeenCalledWith('[sync:za-1] Stopped group message sync');
  });

  it('does no tenant work when the account no longer exists', async () => {
    prismaMock.zaloAccount.findUnique.mockResolvedValue(null);
    const { startMessageSync } = await loadModule();
    const api = { getGroupChatHistory: vi.fn() };
    startMessageSync(api, 'missing');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(prismaMock.conversation.findMany).not.toHaveBeenCalled();
    expect(api.getGroupChatHistory).not.toHaveBeenCalled();
  });

  it('deduplicates history in batch and maps only missing messages to inbound handling', async () => {
    prismaMock.conversation.findMany.mockResolvedValue([{ id: 'conv-1', externalThreadId: 'group-1' }]);
    prismaMock.message.findMany.mockResolvedValue([{ zaloMsgId: 'existing' }]);
    const api = {
      getGroupChatHistory: vi.fn().mockResolvedValue({
        groupMsgs: [
          { data: { msgId: 'existing', content: 'old', uidFrom: 'u1', ts: '100' } },
          { data: { msgId: 'new', content: 'hello', uidFrom: 'u2', dName: 'Customer', ts: '200' }, isSelf: false },
          { data: { msgId: 'new', content: 'latest duplicate wins', uidFrom: 'u2', dName: 'Customer', ts: '201' }, isSelf: false },
        ],
      }),
    };
    const { startMessageSync } = await loadModule();
    startMessageSync(api, 'za-1');
    await vi.advanceTimersByTimeAsync(300_000);

    expect(api.getGroupChatHistory).toHaveBeenCalledWith('group-1', 50);
    expect(prismaMock.message.findMany).toHaveBeenCalledWith({
      where: { conversationId: 'conv-1', zaloMsgId: { in: ['existing', 'new'] } },
      select: { zaloMsgId: true },
    });
    expect(handleIncomingMessageMock).toHaveBeenCalledTimes(1);
    expect(handleIncomingMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'za-1', msgId: 'new', content: 'latest duplicate wins', timestamp: 201,
      threadId: 'group-1', threadType: 'group', isBackfill: true,
    }));
    expect(loggerMock.info).toHaveBeenCalledWith('[sync:za-1] Backfilled 1 group messages');
  });

  it('accepts the nested history response variant and skips messages without ids', async () => {
    prismaMock.conversation.findMany.mockResolvedValue([{ id: 'conv-1', externalThreadId: 'group-1' }]);
    const api = { getGroupChatHistory: vi.fn().mockResolvedValue({ data: { groupMsgs: [{ data: { content: 'no id' } }] } }) };
    const { startMessageSync } = await loadModule();
    startMessageSync(api, 'za-1');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(prismaMock.message.findMany).not.toHaveBeenCalled();
    expect(handleIncomingMessageMock).not.toHaveBeenCalled();
  });

  it('contains one group failure and continues with the remaining groups', async () => {
    prismaMock.conversation.findMany.mockResolvedValue([
      { id: 'bad', externalThreadId: 'group-bad' },
      { id: 'good', externalThreadId: 'group-good' },
    ]);
    const error = new Error('provider down');
    const api = {
      getGroupChatHistory: vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ groupMsgs: [{ data: { msgId: 'new', content: 'ok', uidFrom: 'u1', ts: '1' } }] }),
    };
    const { startMessageSync } = await loadModule();
    startMessageSync(api, 'za-1');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(loggerMock.warn).toHaveBeenCalledWith('[sync:za-1] Group group-bad failed:', error);
    expect(handleIncomingMessageMock).toHaveBeenCalledTimes(1);
  });
});
