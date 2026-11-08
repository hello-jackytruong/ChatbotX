import type { ProviderCommandV1, ProviderResultV1 } from '../zalo-provider/contracts.js';
import type { GatewayCommandRecord, GatewayCommandStatus } from './command-repository.js';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

type CommandRepository = {
  claim(ownerId: string, leaseMs: number, limit: number): Promise<GatewayCommandRecord[]>;
  complete(
    commandId: string,
    ownerId: string,
    completion: { status: GatewayCommandStatus; result: unknown; error: string | null },
  ): Promise<void>;
};

type ProviderExecutor = { execute(command: ProviderCommandV1): Promise<ProviderResultV1> };

const safelyRepeatableOperations = new Set([
  'backfillAccountHistory',
  'findUser',
  'getAccountInfo',
  'getAliasList',
  'getAllFriends',
  'getAllGroups',
  'getFriendOnlines',
  'getFriendRecommendations',
  'getFriendRequestStatus',
  'getGroupBlockedMembers',
  'getGroupInfo',
  'getGroupLinkDetail',
  'getGroupMembersInfo',
  'getLabels',
  'getLastOnline',
  'getOwnId',
  'getPendingGroupMembers',
  'getPinConversations',
  'getPollDetail',
  'getSentFriendRequests',
  'getStickers',
  'getStickersDetail',
  'getUserInfo',
]);

export class GatewayCommandRunner {
  constructor(
    private readonly ownerId: string,
    private readonly repository: CommandRepository,
    private readonly provider: ProviderExecutor,
    private readonly leaseMs = 30_000,
    private readonly batchSize = 10,
  ) {}

  async runOnce(): Promise<number> {
    const commands = await this.repository.claim(this.ownerId, this.leaseMs, this.batchSize);
    for (const command of commands) await this.runCommand(command);
    return commands.length;
  }

  private async runCommand(command: GatewayCommandRecord): Promise<void> {
    const requestedAt = new Date(command.createdAtMs).toISOString();
    try {
      if (command.attempts > 1 && !safelyRepeatableOperations.has(command.kind)) {
        const result: ProviderResultV1 = {
          version: 1,
          commandId: command.commandId,
          status: 'unknown_outcome',
          providerIds: {},
          errorCode: 'PREVIOUS_ATTEMPT_OUTCOME_UNKNOWN',
          retryable: false,
        };
        await this.repository.complete(command.commandId, this.ownerId, {
          status: result.status,
          result,
          error: result.errorCode ?? null,
        });
        return;
      }
      const result = await this.provider.execute({
        version: 1,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        accountId: command.accountId,
        kind: command.kind as ProviderCommandV1['kind'],
        payload: command.payload,
        requestedAt,
        deadlineAt: new Date(Math.max(Date.now() + 1_000, command.createdAtMs + 30_000)).toISOString(),
        traceId: command.commandId,
      });
      await this.repository.complete(command.commandId, this.ownerId, {
        status: result.status,
        result,
        error: result.errorCode ?? null,
      });
    } finally {
      const stagedDirectory = command.payload.stagedDirectory;
      const spoolRoot = resolve(process.env.ZALO_GATEWAY_SPOOL_DIR || '/var/lib/zalo-crm/files/gateway-spool');
      if (typeof stagedDirectory === 'string') {
        const resolved = resolve(stagedDirectory);
        if (resolved.startsWith(`${spoolRoot}/`)) {
          await rm(resolved, { force: true, recursive: true });
        }
      }
    }
  }
}
