import { randomBytes } from 'node:crypto';
import { sealGatewayCredential } from '../src/modules/gateway/credential-store.js';
import { prisma } from '../src/shared/database/prisma-client.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const kid = required('ZALO_BRIDGE_KID');
  const accountId = required('ZALO_BRIDGE_ACCOUNT_ID');
  const chatbotxWorkspaceId = required('CHATBOTX_WORKSPACE_ID');
  const chatbotxInboxId = required('CHATBOTX_INBOX_ID');
  const encryptionKey = required('ZALO_BRIDGE_SECRET_KEY');
  const secret = randomBytes(32).toString('hex');

  await prisma.bridgeClient.create({
    data: {
      kid,
      secretCiphertext: sealGatewayCredential(secret, encryptionKey),
      accountMappings: {
        create: {
          accountId,
          chatbotxWorkspaceId,
          chatbotxInboxId,
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
