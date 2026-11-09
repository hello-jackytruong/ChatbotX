import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import { openGatewayCredential } from '../gateway/credential-store.js';
import type { BridgeKey } from './auth.js';

export class PrismaBridgeKeyResolver {
  async find(kid: string): Promise<BridgeKey | null> {
    const client = await prisma.bridgeClient.findUnique({
      where: { kid },
      select: {
        kid: true,
        secretCiphertext: true,
        previousSecretCiphertext: true,
        previousSecretExpiresAt: true,
        active: true,
        revokedAt: true,
        provisionOrgId: true,
        provisionOwnerUserId: true,
        accountMappings: {
          where: { active: true },
          select: { accountId: true },
        },
      },
    });
    if (!client) return null;
    const key = process.env.ZALO_BRIDGE_SECRET_KEY
      || process.env.ZALO_GATEWAY_CREDENTIAL_KEY
      || process.env.ENCRYPTION_KEY
      || '';
    return {
      kid: client.kid,
      secret: openGatewayCredential(client.secretCiphertext, key),
      previousSecret: client.previousSecretCiphertext
        && client.previousSecretExpiresAt
        && client.previousSecretExpiresAt > new Date()
        ? openGatewayCredential(client.previousSecretCiphertext, key)
        : undefined,
      accountIds: client.accountMappings.map((mapping) => mapping.accountId),
      active: client.active && client.revokedAt === null,
      revokedAt: client.revokedAt ?? undefined,
      provisioningScope: client.provisionOrgId && client.provisionOwnerUserId
        ? {
            orgId: client.provisionOrgId,
            ownerUserId: client.provisionOwnerUserId,
          }
        : undefined,
    };
  }
}

export class PrismaBridgeNonceStore {
  async consume(kid: string, nonce: string, expiresAt: Date): Promise<boolean> {
    try {
      await prisma.bridgeAuthNonce.create({ data: { kid, nonce, expiresAt } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
      throw error;
    }
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "bridge_auth_nonces"
      WHERE ("kid", "nonce") IN (
        SELECT "kid", "nonce" FROM "bridge_auth_nonces"
        WHERE "expires_at" < CURRENT_TIMESTAMP
        ORDER BY "expires_at" ASC
        LIMIT 100
      )
    `);
    return true;
  }
}
