import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { Prisma } from '@prisma/client';
import { prisma } from './shared/database/prisma-client.js';
import { logger } from './shared/utils/logger.js';
import { AccountLeaseService, PrismaAccountLeaseStore, type AccountLease } from './modules/gateway/account-lease.js';
import { PrismaGatewayCommandRepository } from './modules/gateway/command-repository.js';
import { GatewayCommandRunner } from './modules/gateway/command-runner.js';
import { GatewayCredentialStore } from './modules/gateway/credential-store.js';
import { PrismaGatewayEventOutbox } from './modules/gateway/event-outbox.js';
import { GatewaySocketOutbox } from './modules/gateway/gateway-socket-outbox.js';
import { eligibleGatewayAccountIds, readGatewayRolloutConfig } from './modules/gateway/rollout.js';
import { zaloProviderClient } from './modules/zalo-provider/client.js';

const instanceId = process.env.ZALO_GATEWAY_INSTANCE_ID || `gateway-${randomUUID()}`;
const leaseTtlMs = 30_000;
const heartbeatMs = 10_000;
const reconcileMs = 10_000;
const rollout = readGatewayRolloutConfig(process.env);

const sql = prisma as never;
const leases = new AccountLeaseService(new PrismaAccountLeaseStore(sql), leaseTtlMs);
const commands = new PrismaGatewayCommandRepository(sql);
const commandRunner = new GatewayCommandRunner(instanceId, commands, zaloProviderClient);
const activeLeases = new Map<string, AccountLease>();
const eventOutbox = new PrismaGatewayEventOutbox(sql);
const socketOutbox = new GatewaySocketOutbox(eventOutbox, (accountId) => {
  const lease = activeLeases.get(accountId);
  return lease ? { ownerId: instanceId, fenceToken: lease.fenceToken } : null;
});

const credentialKey = process.env.ZALO_GATEWAY_CREDENTIAL_KEY || process.env.ENCRYPTION_KEY || '';
const credentials = new GatewayCredentialStore({
  read: async (accountId) => prisma.zaloAccount.findUnique({
    where: { id: accountId },
    select: { sessionCiphertext: true, proxyCiphertext: true, sessionData: true, proxyUrl: true },
  }),
  write: async (accountId, data) => {
    await prisma.zaloAccount.update({
      where: { id: accountId },
      data: data as Prisma.ZaloAccountUpdateInput,
    });
  },
}, credentialKey);

let stopping = false;

async function stopOwnedListeners(): Promise<void> {
  for (const [accountId, lease] of activeLeases) {
    await zaloProviderClient.disconnect(accountId);
    await leases.release(accountId, instanceId, lease.fenceToken).catch(() => false);
  }
  activeLeases.clear();
}

async function reconcileAccounts(): Promise<void> {
  try {
    const accounts = await prisma.zaloAccount.findMany({
      where: { archivedAt: null },
      select: { id: true, zaloUid: true },
    });
    const eligible = eligibleGatewayAccountIds(
      accounts.map((account) => account.id),
      rollout,
    );
    for (const accountId of eligible) {
      const acquired = await leases.acquire(accountId, instanceId);
      if (!acquired.acquired) continue;
      activeLeases.set(accountId, acquired);
      if (zaloProviderClient.isConnected(accountId)) continue;
      const stored = await credentials.read(accountId);
      const account = accounts.find((candidate) => candidate.id === accountId);
      if (!account?.zaloUid || !stored?.session?.imei) continue;
      await zaloProviderClient.reconnect(accountId, stored.session, stored.proxyUrl);
    }
    for (const [accountId, lease] of activeLeases) {
      if (eligible.has(accountId)) continue;
      await zaloProviderClient.disconnect(accountId);
      await leases.release(accountId, instanceId, lease.fenceToken);
      activeLeases.delete(accountId);
    }
  } catch (err) {
    logger.error('[zalo-gateway] account reconciliation failed; stopping owned listeners', err);
    await stopOwnedListeners();
    throw err;
  }
}

async function heartbeat(): Promise<void> {
  for (const [accountId, lease] of activeLeases) {
    const renewed = await leases.heartbeat(accountId, instanceId, lease.fenceToken).catch(() => false);
    if (!renewed) {
      await zaloProviderClient.disconnect(accountId);
      activeLeases.delete(accountId);
    }
  }
}

async function commandLoop(): Promise<void> {
  while (!stopping) {
    try {
      if (!rollout.commandClaimsEnabled) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      const processed = await commandRunner.runOnce();
      if (processed === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (err) {
      logger.error('[zalo-gateway] command loop failed', err);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info(`[zalo-gateway] stopping on ${signal}`);
  await rm('/tmp/zalo-gateway-ready', { force: true });
  await stopOwnedListeners();
  await socketOutbox.drain();
  await prisma.$disconnect();
}

async function bootstrap(): Promise<void> {
  zaloProviderClient.setIO(socketOutbox as never);
  await Promise.race([
    (async () => {
      await reconcileAccounts();
      const reconcileTimer = setInterval(() => void reconcileAccounts(), reconcileMs);
      const heartbeatTimer = setInterval(() => void heartbeat(), heartbeatMs);
      reconcileTimer.unref();
      heartbeatTimer.unref();
      process.once('SIGTERM', () => void shutdown('SIGTERM'));
      process.once('SIGINT', () => void shutdown('SIGINT'));
      logger.info(`[zalo-gateway] ready instance=${instanceId}`);
      await writeFile('/tmp/zalo-gateway-ready', instanceId, { mode: 0o600 });
      await commandLoop();
    })(),
    socketOutbox.waitForFailure(),
  ]);
}

bootstrap().catch(async (err) => {
  logger.error('[zalo-gateway] fatal startup error', err);
  await shutdown('fatal-error').catch(() => undefined);
  process.exitCode = 1;
});
