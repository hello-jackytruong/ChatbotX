import { randomUUID } from 'node:crypto';
import { logger } from '../../shared/utils/logger.js';
import type { GatewayEventAppend } from './event-outbox.js';

type EventAppender = { append(input: GatewayEventAppend): Promise<unknown> };
type LeaseIdentity = { ownerId: string; fenceToken: bigint };
type LeaseResolver = (accountId: string) => LeaseIdentity | null;
const DEFAULT_RETRY_DELAYS_MS = [100, 500, 2_000] as const;

type ScopedEmitter = {
  emit(event: string, payload: unknown): boolean;
  isActive(): boolean;
  to(room: string): ScopedEmitter;
};

function eventKind(event: string): GatewayEventAppend['kind'] {
  if (event.includes('typing')) return 'typing';
  if (event.includes('reaction')) return 'reaction';
  if (event.includes('undo')) return 'undo';
  if (event.includes('seen')) return 'seen';
  if (event.includes('delivered') || event.includes('message-status')) return 'delivered';
  if (event.startsWith('friend:')) return 'friend';
  if (event.startsWith('group:')) return 'group';
  if (event.startsWith('zalo:') && !event.includes('message')) return 'account_status';
  return 'message';
}

export class GatewaySocketOutbox {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly failureSignal: Promise<never>;
  private rejectFailure!: (reason: unknown) => void;
  private failure: unknown = null;

  constructor(
    private readonly events: EventAppender,
    private readonly resolveLease: LeaseResolver,
    private readonly retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
  ) {
    this.failureSignal = new Promise<never>((_resolve, reject) => {
      this.rejectFailure = reject;
    });
  }

  forAccount(accountId: string): ScopedEmitter {
    return this.scoped(accountId, null);
  }

  emit(event: string, payload: unknown): boolean {
    const accountId = payload && typeof payload === 'object'
      ? String((payload as Record<string, unknown>).accountId ?? '')
      : '';
    if (accountId) this.enqueue(accountId, null, event, payload);
    return true;
  }

  to(room: string): ScopedEmitter {
    return {
      emit: (event, payload) => this.emitToInferredAccount(room, event, payload),
      isActive: () => false,
      to: (nextRoom) => this.to(nextRoom),
    };
  }

  async drain(): Promise<void> {
    await Promise.all([...this.pending]);
    if (this.failure) throw this.failure;
  }

  waitForFailure(): Promise<never> {
    return this.failureSignal;
  }

  private scoped(accountId: string, room: string | null): ScopedEmitter {
    return {
      emit: (event, payload) => {
        this.enqueue(accountId, room, event, payload);
        return true;
      },
      isActive: () => this.resolveLease(accountId) !== null,
      to: (nextRoom) => this.scoped(accountId, nextRoom),
    };
  }

  private emitToInferredAccount(room: string, event: string, payload: unknown): boolean {
    const payloadAccount = payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>).accountId
        ?? (payload as Record<string, unknown>).zaloAccountId
      : null;
    const roomAccount = room.startsWith('account:') ? room.slice('account:'.length) : null;
    const accountId = String(payloadAccount ?? roomAccount ?? '');
    if (accountId) this.enqueue(accountId, room, event, payload);
    return true;
  }

  private enqueue(accountId: string, room: string | null, event: string, payload: unknown): void {
    const lease = this.resolveLease(accountId);
    if (!lease) return;
    const task = this.appendWithRetry({
      eventId: randomUUID(),
      accountId,
      ownerId: lease.ownerId,
      fenceToken: lease.fenceToken,
      kind: eventKind(event),
      payload: { room, event, payload } as Record<string, unknown>,
      occurredAt: new Date(),
    }).catch((err) => {
      this.failure = err;
      logger.error(`[zalo-gateway:${accountId}] socket outbox append failed permanently`, err);
      this.rejectFailure(err);
    }).finally(() => {
      this.pending.delete(task);
    });
    this.pending.add(task);
  }

  private async appendWithRetry(input: GatewayEventAppend): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.events.append(input);
      } catch (err) {
        const delayMs = this.retryDelaysMs[attempt];
        if (delayMs === undefined) throw err;
        logger.warn(
          `[zalo-gateway:${input.accountId}] socket outbox append retry ${attempt + 1}`,
          err,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}
