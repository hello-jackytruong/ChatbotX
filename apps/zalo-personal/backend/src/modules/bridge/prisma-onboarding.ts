import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import {
  openGatewayCredential,
  sealGatewayCredential,
} from '../gateway/credential-store.js';

type ProvisionInput = {
  connectSessionId: string;
  orgId: string;
  ownerUserId: string;
  workspaceId: string;
};

type ProvisionResult = {
  accountId: string;
  keyId: string;
  secret: string;
};

export type CleanupResult = 'cleaned' | 'not_found';

class CleanupConflict extends Error {}

const credentialKey = (): string =>
  process.env.ZALO_BRIDGE_SECRET_KEY
  || process.env.ZALO_GATEWAY_CREDENTIAL_KEY
  || process.env.ENCRYPTION_KEY
  || '';

export class PrismaBridgeOnboardingRepository {
  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const existing = await this.findExisting(input);
    if (existing) return existing;

    try {
      return await prisma.$transaction(async (tx) => {
        const owner = await tx.user.findFirst({
          where: {
            id: input.ownerUserId,
            orgId: input.orgId,
            isActive: true,
          },
          select: { id: true },
        });
        if (!owner) throw new Error('PROVISIONING_OWNER_NOT_FOUND');

        const account = await tx.zaloAccount.create({
          data: {
            orgId: input.orgId,
            ownerUserId: input.ownerUserId,
            displayName: 'ChatbotX Zalo Personal',
            status: 'qr_pending',
          },
          select: { id: true },
        });
        await tx.zaloAccountAccess.create({
          data: {
            zaloAccountId: account.id,
            userId: input.ownerUserId,
            permission: 'admin',
          },
        });

        const secret = randomBytes(32).toString('hex');
        const client = await tx.bridgeClient.create({
          data: {
            kid: `chatbotx-account-${randomUUID()}`,
            secretCiphertext: sealGatewayCredential(secret, credentialKey()),
          },
          select: { id: true, kid: true },
        });
        await tx.bridgeAccountMapping.create({
          data: {
            clientId: client.id,
            accountId: account.id,
            chatbotxWorkspaceId: input.workspaceId,
            chatbotxConnectSessionId: input.connectSessionId,
          },
        });
        return { accountId: account.id, keyId: client.kid, secret };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError
        && (error.code === 'P2002' || error.code === 'P2034')
      ) {
        const raced = await this.findExisting(input);
        if (raced) return raced;
      }
      throw error;
    }
  }

  async cleanup(input: {
    accountId: string;
    kid: string;
    connectSessionId: string;
  }): Promise<CleanupResult> {
    try {
      return await prisma.$transaction(async (tx) => {
        const mapping = await tx.bridgeAccountMapping.findFirst({
          where: {
            accountId: input.accountId,
            chatbotxConnectSessionId: input.connectSessionId,
            chatbotxInboxId: null,
            client: { kid: input.kid },
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
        if (!mapping) return 'not_found';
        if (
          !mapping.active
          && !mapping.client.active
          && mapping.client.revokedAt
          && mapping.account.archivedAt
          && mapping.account.zaloUid === null
        ) return 'cleaned';
        if (
          !mapping.active
          || !mapping.client.active
          || mapping.client.revokedAt
          || mapping.account.archivedAt
          || mapping.account.zaloUid
          || !['qr_pending', 'disconnected'].includes(mapping.account.status)
        ) return 'not_found';

        const mappingUpdate = await tx.bridgeAccountMapping.updateMany({
          where: {
            id: mapping.id,
            active: true,
            chatbotxConnectSessionId: input.connectSessionId,
            chatbotxInboxId: null,
          },
          data: { active: false },
        });
        if (mappingUpdate.count !== 1) throw new CleanupConflict();

        const now = new Date();
        const accountUpdate = await tx.zaloAccount.updateMany({
          where: {
            id: input.accountId,
            archivedAt: null,
            zaloUid: null,
            status: { in: ['qr_pending', 'disconnected'] },
          },
          data: {
            archivedAt: now,
            disconnectedAt: now,
            disconnectReason: 'manual',
            sessionData: Prisma.JsonNull,
            status: 'disconnected',
          },
        });
        if (accountUpdate.count !== 1) throw new CleanupConflict();

        const clientUpdate = await tx.bridgeClient.updateMany({
          where: {
            id: mapping.clientId,
            kid: input.kid,
            active: true,
            revokedAt: null,
          },
          data: { active: false, revokedAt: now },
        });
        if (clientUpdate.count !== 1) throw new CleanupConflict();
        return 'cleaned';
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof CleanupConflict) return 'not_found';
      throw error;
    }
  }

  private async findExisting(input: ProvisionInput): Promise<ProvisionResult | null> {
    const mapping = await prisma.bridgeAccountMapping.findUnique({
      where: { chatbotxConnectSessionId: input.connectSessionId },
      select: {
        accountId: true,
        chatbotxWorkspaceId: true,
        account: {
          select: { orgId: true, ownerUserId: true },
        },
        client: {
          select: {
            active: true,
            kid: true,
            revokedAt: true,
            secretCiphertext: true,
          },
        },
      },
    });
    if (!mapping) return null;
    if (
      mapping.chatbotxWorkspaceId !== input.workspaceId
      || mapping.account.orgId !== input.orgId
      || mapping.account.ownerUserId !== input.ownerUserId
      || !mapping.client.active
      || mapping.client.revokedAt
    ) {
      throw new Error('PROVISIONING_SESSION_CONFLICT');
    }
    return {
      accountId: mapping.accountId,
      keyId: mapping.client.kid,
      secret: openGatewayCredential(
        mapping.client.secretCiphertext,
        credentialKey(),
      ),
    };
  }
}
