import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { PrismaGatewayCommandRepository } from '../gateway/command-repository.js';
import { GatewayProviderClient } from './gateway-provider-client.js';
import type { ProviderOperationName } from './contracts.js';
import { prepareGatewayOperation } from './gateway-operation-payload.js';

const durableGatewayClient = new GatewayProviderClient(
  new PrismaGatewayCommandRepository(prisma as never),
);

export class GatewayOperationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'GatewayOperationError';
  }
}

function gatewayAccountAllowlist(): Set<string> {
  return new Set(
    (process.env.ZALO_GATEWAY_ACCOUNT_ALLOWLIST || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function usesRemoteGateway(accountId: string): boolean {
  return process.env.ZALO_PERSONAL_PROVIDER_MODE === 'gateway'
    && process.env.ZALO_PERSONAL_RUNTIME_ROLE !== 'gateway'
    && process.env.ZALO_GATEWAY_CLAIMS_ENABLED === 'true'
    && gatewayAccountAllowlist().has(accountId);
}

export async function executeGatewayOperation(
  kind: ProviderOperationName,
  accountId: string,
  args: unknown[],
  payloadMetadata: Record<string, unknown> = {},
): Promise<unknown> {
  const commandId = randomUUID();
  const now = Date.now();
  const prepared = await prepareGatewayOperation(kind, args, commandId);
  const result = await durableGatewayClient.execute({
    version: 1,
    commandId,
    idempotencyKey: commandId,
    accountId,
    kind,
    payload: {
      args: prepared.args,
      ...(prepared.stagedDirectory ? { stagedDirectory: prepared.stagedDirectory } : {}),
      ...payloadMetadata,
    },
    requestedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + 30_000).toISOString(),
    traceId: commandId,
  });
  if (result.status === 'succeeded') return result.payload?.result;

  const code = result.errorCode || 'API_ERROR';
  const statusCode = code === 'RATE_LIMITED' ? 429 : code === 'SESSION_EXPIRED' ? 401 : 400;
  const message = typeof result.payload?.legacyMessage === 'string'
    ? result.payload.legacyMessage
    : code;
  throw new GatewayOperationError(message, code, statusCode);
}
