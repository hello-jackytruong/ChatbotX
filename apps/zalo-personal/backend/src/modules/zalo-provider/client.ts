import type { Server } from 'socket.io';
import { sendNativeVideo, type SendNativeVideoParams } from '../../shared/video-processor.js';
import { backfillAccountHistory, type BackfillResult } from '../zalo/zalo-history-backfill.js';
import { zaloPool } from '../zalo/zalo-pool.js';
import { providerCommandSchema, type ProviderCommandV1, type ProviderResultV1 } from './contracts.js';
import { runProviderCommand } from './command-runner.js';
import { mapProviderError } from './error-mapper.js';
import { executeGatewayOperation, usesRemoteGateway } from './remote-operation.js';
import { getGatewayCachedStatus, getGatewayCachedStatuses } from './gateway-status-cache.js';

export type ProviderAccountStatus = 'connected' | 'connecting' | 'disconnected' | 'qr_pending';

export type ProviderCredentials = {
  cookie: unknown;
  imei: string;
  userAgent: string;
};

type PoolLifecyclePort = {
  cleanupStaleGhosts: (olderThanMinutes?: number) => Promise<number>;
  disconnect: (accountId: string) => void;
  getAllStatuses: () => Record<string, string>;
  getApi: (accountId: string) => any | null;
  getIO: () => Server | null;
  getInstance: (accountId: string) => { api?: any; status: ProviderAccountStatus } | undefined;
  getStatus: (accountId: string) => string;
  loginQR: (accountId: string, proxyUrl?: string | null) => Promise<void>;
  reconnect: (
    accountId: string,
    credentials: ProviderCredentials,
    proxyUrl?: string | null,
  ) => Promise<void>;
  setIO: (io: Server) => void;
};

export type ProviderCapability =
  | 'alias_list'
  | 'all_friends'
  | 'find_user'
  | 'group_history'
  | 'labels'
  | 'message'
  | 'native_video'
  | 'stickers'
  | 'user_info';

const capabilityMethods: Record<ProviderCapability, readonly string[]> = {
  alias_list: ['getAliasList'],
  all_friends: ['getAllFriends'],
  find_user: ['findUser'],
  group_history: ['getAllGroups', 'getGroupChatHistory'],
  labels: ['getLabels', 'updateLabels'],
  message: ['sendMessage'],
  native_video: ['uploadAttachment', 'sendVideo'],
  stickers: ['getStickers', 'getStickersDetail'],
  user_info: ['getUserInfo'],
};

type CommandRunner = (command: ProviderCommandV1) => Promise<unknown>;
type CommandEntry = { fingerprint: string; result: Promise<ProviderResultV1> };
type GatewayTransport = {
  execute: typeof executeGatewayOperation;
  getAllStatuses: typeof getGatewayCachedStatuses;
  getStatus: typeof getGatewayCachedStatus;
  isEnabled: typeof usesRemoteGateway;
};

const defaultGatewayTransport: GatewayTransport = {
  execute: executeGatewayOperation,
  getAllStatuses: getGatewayCachedStatuses,
  getStatus: getGatewayCachedStatus,
  isEnabled: usesRemoteGateway,
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function extractProviderIds(value: unknown): Record<string, string> {
  const result = value as any;
  const messageId = result?.message?.msgId ?? result?.msgId ?? result?.data?.msgId
    ?? result?.attachment?.[0]?.msgId;
  const clientMessageId = result?.message?.cliMsgId ?? result?.cliMsgId ?? result?.data?.cliMsgId;
  return {
    ...(messageId == null ? {} : { messageId: String(messageId) }),
    ...(clientMessageId == null ? {} : { clientMessageId: String(clientMessageId) }),
  };
}

export class ProviderCommandConflictError extends Error {
  constructor() {
    super('Provider idempotency key already exists with a different payload');
    this.name = 'ProviderCommandConflictError';
  }
}

export class ZaloProviderClient {
  private readonly commands = new Map<string, CommandEntry>();

  constructor(
    private readonly pool: PoolLifecyclePort,
    private readonly commandRunner: CommandRunner = runProviderCommand,
    private readonly gateway: GatewayTransport = defaultGatewayTransport,
  ) {}

  async execute(input: ProviderCommandV1): Promise<ProviderResultV1> {
    const command = providerCommandSchema.parse(input);
    const key = `${command.accountId}:${command.idempotencyKey}`;
    const fingerprint = JSON.stringify(canonicalize({ kind: command.kind, payload: command.payload }));
    const existing = this.commands.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ProviderCommandConflictError();
      return existing.result;
    }

    const result = this.commandRunner(command)
      .then((value): ProviderResultV1 => ({
        version: 1,
        commandId: command.commandId,
        status: 'succeeded',
        providerIds: extractProviderIds(value),
        retryable: false,
        payload: value && typeof value === 'object'
          ? { result: value }
          : { result: value ?? null },
      }))
      .catch((error) => mapProviderError(command.commandId, error));
    this.commands.set(key, { fingerprint, result });
    return result;
  }

  private requireApi(accountId: string): any {
    const instance = this.pool.getInstance(accountId);
    if (!instance?.api || instance.status !== 'connected') {
      throw new Error('Zalo account not connected');
    }
    return instance.api;
  }

  getStatus(accountId: string): ProviderAccountStatus {
    if (this.gateway.isEnabled(accountId)) return this.gateway.getStatus(accountId);
    return this.pool.getStatus(accountId) as ProviderAccountStatus;
  }

  isConnected(accountId: string): boolean {
    return this.getStatus(accountId) === 'connected';
  }

  supports(accountId: string, capability: ProviderCapability): boolean {
    if (this.gateway.isEnabled(accountId)) return this.isConnected(accountId);
    const api = this.pool.getApi(accountId);
    return Boolean(api && capabilityMethods[capability].every((method) => typeof api[method] === 'function'));
  }

  async sendMessageDirect(
    accountId: string,
    content: unknown,
    threadId: string,
    threadType: 0 | 1,
  ): Promise<unknown> {
    if (this.gateway.isEnabled(accountId)) {
      return this.gateway.execute('sendMessage', accountId, [content, threadId, threadType], {
        executionPolicy: 'legacy_direct',
      });
    }
    return this.requireApi(accountId).sendMessage(content, threadId, threadType);
  }

  async getUserInfoDirect(accountId: string, userId: string): Promise<any> {
    if (this.gateway.isEnabled(accountId)) return this.gateway.execute('getUserInfo', accountId, [userId], { executionPolicy: 'legacy_direct' });
    return this.requireApi(accountId).getUserInfo(userId);
  }

  async getAllFriendsDirect(accountId: string): Promise<any> {
    if (this.gateway.isEnabled(accountId)) return this.gateway.execute('getAllFriends', accountId, [], { executionPolicy: 'legacy_direct' });
    return this.requireApi(accountId).getAllFriends();
  }

  async findUserDirect(accountId: string, query: string): Promise<any> {
    if (this.gateway.isEnabled(accountId)) return this.gateway.execute('findUser', accountId, [query], { executionPolicy: 'legacy_direct' });
    return this.requireApi(accountId).findUser(query);
  }

  async uploadAttachmentDirect(
    accountId: string,
    paths: string[],
    threadId: string,
    threadType: 0 | 1,
  ): Promise<unknown[]> {
    if (this.gateway.isEnabled(accountId)) {
      return this.gateway.execute('uploadAttachment', accountId, [paths, threadId, threadType], {
        executionPolicy: 'legacy_direct',
      }) as Promise<unknown[]>;
    }
    return this.requireApi(accountId).uploadAttachment(paths, threadId, threadType);
  }

  async getAliasListDirect(accountId: string, count: number, page: number): Promise<any> {
    if (this.gateway.isEnabled(accountId)) return this.gateway.execute('getAliasList', accountId, [count, page], { executionPolicy: 'legacy_direct' });
    return this.requireApi(accountId).getAliasList(count, page);
  }

  async getLabelsDirect(accountId: string): Promise<any> {
    if (this.gateway.isEnabled(accountId)) return this.gateway.execute('getLabels', accountId, [], { executionPolicy: 'legacy_direct' });
    return this.requireApi(accountId).getLabels();
  }

  async updateLabelsDirect(accountId: string, payload: unknown): Promise<any> {
    if (this.gateway.isEnabled(accountId)) return this.gateway.execute('updateLabels', accountId, [payload], { executionPolicy: 'legacy_direct' });
    return this.requireApi(accountId).updateLabels(payload);
  }

  async getStickersDirect(accountId: string, keyword: string): Promise<number[]> {
    if (this.gateway.isEnabled(accountId)) return this.gateway.execute('getStickers', accountId, [keyword], { executionPolicy: 'legacy_direct' }) as Promise<number[]>;
    return this.requireApi(accountId).getStickers(keyword);
  }

  async getStickersDetailDirect(accountId: string, ids: number[]): Promise<unknown[]> {
    if (this.gateway.isEnabled(accountId)) return this.gateway.execute('getStickersDetail', accountId, [ids], { executionPolicy: 'legacy_direct' }) as Promise<unknown[]>;
    return this.requireApi(accountId).getStickersDetail(ids);
  }

  async sendNativeVideoDirect(
    accountId: string,
    params: Omit<SendNativeVideoParams, 'api'>,
  ): Promise<unknown> {
    if (this.gateway.isEnabled(accountId)) return this.gateway.execute('sendNativeVideo', accountId, [params], { executionPolicy: 'legacy_direct' });
    return sendNativeVideo({ ...params, api: this.requireApi(accountId) });
  }

  async backfillAccountHistoryDirect(accountId: string): Promise<BackfillResult> {
    if (this.gateway.isEnabled(accountId)) {
      return this.gateway.execute('backfillAccountHistory', accountId, [], {
        executionPolicy: 'legacy_direct',
      }) as Promise<BackfillResult>;
    }
    return backfillAccountHistory(this.requireApi(accountId), accountId);
  }

  getAllStatuses(): Record<string, ProviderAccountStatus> {
    const statuses = this.pool.getAllStatuses() as Record<string, ProviderAccountStatus>;
    for (const [accountId, status] of Object.entries(this.gateway.getAllStatuses())) {
      if (this.gateway.isEnabled(accountId)) statuses[accountId] = status;
    }
    return statuses;
  }

  getIO(): Server | null {
    return this.pool.getIO();
  }

  setIO(io: Server): void {
    this.pool.setIO(io);
  }

  async loginWithQr(accountId: string, proxyUrl?: string | null): Promise<void> {
    if (this.gateway.isEnabled(accountId)) {
      await this.gateway.execute('loginWithQr', accountId, []);
      return;
    }
    return proxyUrl === undefined
      ? this.pool.loginQR(accountId)
      : this.pool.loginQR(accountId, proxyUrl);
  }

  reconnect(
    accountId: string,
    credentials: ProviderCredentials,
    proxyUrl?: string | null,
  ): Promise<void> {
    if (this.gateway.isEnabled(accountId)) {
      return this.gateway.execute('reconnectAccount', accountId, []).then(() => undefined);
    }
    return proxyUrl === undefined
      ? this.pool.reconnect(accountId, credentials)
      : this.pool.reconnect(accountId, credentials, proxyUrl);
  }

  async disconnect(accountId: string): Promise<void> {
    if (this.gateway.isEnabled(accountId)) {
      await this.gateway.execute('disconnectAccount', accountId, []);
      return;
    }
    this.pool.disconnect(accountId);
  }

  cleanupStaleGhosts(olderThanMinutes?: number): Promise<number> {
    return this.pool.cleanupStaleGhosts(olderThanMinutes);
  }
}

const lazyPool: PoolLifecyclePort = {
  cleanupStaleGhosts: (olderThanMinutes) => zaloPool.cleanupStaleGhosts(olderThanMinutes),
  disconnect: (accountId) => zaloPool.disconnect(accountId),
  getAllStatuses: () => zaloPool.getAllStatuses(),
  getApi: (accountId) => zaloPool.getApi(accountId),
  getIO: () => zaloPool.getIO(),
  getInstance: (accountId) => zaloPool.getInstance(accountId),
  getStatus: (accountId) => zaloPool.getStatus(accountId),
  loginQR: (accountId, proxyUrl) => proxyUrl === undefined
    ? zaloPool.loginQR(accountId)
    : zaloPool.loginQR(accountId, proxyUrl),
  reconnect: (accountId, credentials, proxyUrl) => proxyUrl === undefined
    ? zaloPool.reconnect(accountId, credentials)
    : zaloPool.reconnect(accountId, credentials, proxyUrl),
  setIO: (io) => zaloPool.setIO(io),
};

export const zaloProviderClient = new ZaloProviderClient(lazyPool);
