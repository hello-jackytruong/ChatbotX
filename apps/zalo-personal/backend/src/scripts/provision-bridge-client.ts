import { randomBytes } from 'node:crypto';
import { sealGatewayCredential } from '../modules/gateway/credential-store.js';
import { prisma } from '../shared/database/prisma-client.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

async function main(): Promise<void> {
  const kid = required('ZALO_BRIDGE_KID');
  const encryptionKey = required('ZALO_BRIDGE_SECRET_KEY');
  const secret = randomBytes(32).toString('hex');
  const provisionOrgId = optional('ZALO_BRIDGE_PROVISION_ORG_ID');
  const provisionOwnerUserId = optional('ZALO_BRIDGE_PROVISION_OWNER_USER_ID');

  if (Boolean(provisionOrgId) !== Boolean(provisionOwnerUserId)) {
    throw new Error(
      'ZALO_BRIDGE_PROVISION_ORG_ID and ZALO_BRIDGE_PROVISION_OWNER_USER_ID must be set together',
    );
  }

  if (provisionOrgId && provisionOwnerUserId) {
    await prisma.bridgeClient.create({
      data: {
        kid,
        secretCiphertext: sealGatewayCredential(secret, encryptionKey),
        provisionOrgId,
        provisionOwnerUserId,
      },
    });
    process.stdout.write(`${JSON.stringify({ kid, secret })}\n`);
    return;
  }

  const accountId = required('ZALO_BRIDGE_ACCOUNT_ID');
  const chatbotxWorkspaceId = required('CHATBOTX_WORKSPACE_ID');
  const chatbotxInboxId = optional('CHATBOTX_INBOX_ID');

  await prisma.bridgeClient.create({
    data: {
      kid,
      secretCiphertext: sealGatewayCredential(secret, encryptionKey),
      accountMappings: {
        create: {
          accountId,
          chatbotxWorkspaceId,
          ...(chatbotxInboxId ? { chatbotxInboxId } : {}),
        },
      },
    },
  });

  process.stdout.write(`${JSON.stringify({ kid, secret })}\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
