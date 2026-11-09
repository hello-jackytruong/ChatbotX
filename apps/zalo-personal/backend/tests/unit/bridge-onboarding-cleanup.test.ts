import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tx = {
  bridgeAccountMapping: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  bridgeClient: { updateMany: vi.fn() },
  zaloAccount: { updateMany: vi.fn() },
};

vi.mock('../../src/shared/database/prisma-client.js', () => ({
  prisma: {
    $transaction: (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  },
}));

const { PrismaBridgeOnboardingRepository } = await import(
  '../../src/modules/bridge/prisma-onboarding.js'
);

describe('PrismaBridgeOnboardingRepository.cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.bridgeAccountMapping.updateMany.mockResolvedValue({ count: 1 });
    tx.bridgeClient.updateMany.mockResolvedValue({ count: 1 });
    tx.zaloAccount.updateMany.mockResolvedValue({ count: 1 });
  });

  it('revokes the scoped client, mapping and unconnected account together', async () => {
    tx.bridgeAccountMapping.findFirst.mockResolvedValue({
      id: 'mapping-1',
      active: true,
      clientId: 'client-id-1',
      client: { active: true, revokedAt: null },
      account: { archivedAt: null, status: 'qr_pending', zaloUid: null },
    });
    const repository = new PrismaBridgeOnboardingRepository();

    await expect(repository.cleanup({
      accountId: 'account-1',
      kid: 'client-1',
      connectSessionId: 'session-1',
    })).resolves.toBe('cleaned');

    expect(tx.bridgeAccountMapping.findFirst).toHaveBeenCalledWith({
      where: {
        accountId: 'account-1',
        chatbotxConnectSessionId: 'session-1',
        chatbotxInboxId: null,
        client: { kid: 'client-1' },
      },
      select: {
        id: true,
        active: true,
        clientId: true,
        client: { select: { active: true, revokedAt: true } },
        account: {
          select: { archivedAt: true, status: true, zaloUid: true },
        },
      },
    });
    expect(tx.bridgeAccountMapping.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'mapping-1',
        active: true,
        chatbotxConnectSessionId: 'session-1',
        chatbotxInboxId: null,
      },
      data: { active: false },
    });
    expect(tx.bridgeClient.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'client-id-1',
        kid: 'client-1',
        active: true,
        revokedAt: null,
      },
      data: { active: false, revokedAt: expect.any(Date) },
    });
    expect(tx.zaloAccount.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'account-1',
        archivedAt: null,
        zaloUid: null,
        status: { in: ['qr_pending', 'disconnected'] },
      },
      data: {
        archivedAt: expect.any(Date),
        disconnectedAt: expect.any(Date),
        disconnectReason: 'manual',
        sessionData: Prisma.JsonNull,
        status: 'disconnected',
      },
    });
  });

  it('does not touch a non-onboarding account', async () => {
    tx.bridgeAccountMapping.findFirst.mockResolvedValue(null);
    const repository = new PrismaBridgeOnboardingRepository();

    await expect(repository.cleanup({
      accountId: 'account-1',
      kid: 'client-1',
      connectSessionId: 'session-1',
    })).resolves.toBe('not_found');

    expect(tx.bridgeAccountMapping.updateMany).not.toHaveBeenCalled();
    expect(tx.bridgeClient.updateMany).not.toHaveBeenCalled();
    expect(tx.zaloAccount.updateMany).not.toHaveBeenCalled();
  });

  it('rolls back instead of archiving when binding wins the cleanup race', async () => {
    tx.bridgeAccountMapping.findFirst.mockResolvedValue({
      id: 'mapping-1',
      active: true,
      clientId: 'client-id-1',
      client: { active: true, revokedAt: null },
      account: { archivedAt: null, status: 'qr_pending', zaloUid: null },
    });
    tx.bridgeAccountMapping.updateMany.mockResolvedValue({ count: 0 });
    const repository = new PrismaBridgeOnboardingRepository();

    await expect(repository.cleanup({
      accountId: 'account-1',
      kid: 'client-1',
      connectSessionId: 'session-1',
    })).resolves.toBe('not_found');

    expect(tx.zaloAccount.updateMany).not.toHaveBeenCalled();
    expect(tx.bridgeClient.updateMany).not.toHaveBeenCalled();
  });

  it('treats a response-loss retry of the same cleanup as already cleaned', async () => {
    tx.bridgeAccountMapping.findFirst.mockResolvedValue({
      id: 'mapping-1',
      active: false,
      clientId: 'client-id-1',
      client: { active: false, revokedAt: new Date() },
      account: {
        archivedAt: new Date(),
        status: 'disconnected',
        zaloUid: null,
      },
    });
    const repository = new PrismaBridgeOnboardingRepository();

    await expect(repository.cleanup({
      accountId: 'account-1',
      kid: 'client-1',
      connectSessionId: 'session-1',
    })).resolves.toBe('cleaned');

    expect(tx.bridgeAccountMapping.updateMany).not.toHaveBeenCalled();
    expect(tx.zaloAccount.updateMany).not.toHaveBeenCalled();
    expect(tx.bridgeClient.updateMany).not.toHaveBeenCalled();
  });
});
