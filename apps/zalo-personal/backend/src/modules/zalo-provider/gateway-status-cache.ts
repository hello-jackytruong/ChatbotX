import { prisma } from '../../shared/database/prisma-client.js';
import type { ProviderAccountStatus } from './client.js';

const statuses = new Map<string, ProviderAccountStatus>();

export async function refreshGatewayStatusCache(): Promise<void> {
  const accounts = await prisma.zaloAccount.findMany({ select: { id: true, status: true } });
  statuses.clear();
  for (const account of accounts) {
    const status = account.status as ProviderAccountStatus;
    statuses.set(account.id, status);
  }
}

export function getGatewayCachedStatus(accountId: string): ProviderAccountStatus {
  return statuses.get(accountId) ?? 'disconnected';
}

export function getGatewayCachedStatuses(): Record<string, ProviderAccountStatus> {
  return Object.fromEntries(statuses);
}

export async function startGatewayStatusCache(intervalMs = 1_000): Promise<void> {
  await refreshGatewayStatusCache();
  const timer = setInterval(() => void refreshGatewayStatusCache(), intervalMs);
  timer.unref();
}
