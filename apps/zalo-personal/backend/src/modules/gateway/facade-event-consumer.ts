import type { GatewayEventRecord } from './event-outbox.js';

export type EventProjection = (event: GatewayEventRecord) => Promise<void>;
export type EventEmitter = (event: GatewayEventRecord) => Promise<void> | void;

export class FacadeEventConsumer {
  private readonly checkpoints = new Map<string, bigint>();
  private readonly projected = new Set<string>();

  constructor(
    private readonly consumerName: string,
    private readonly project: EventProjection,
    private readonly emitAfterCommit: EventEmitter,
  ) {}

  async consume(events: GatewayEventRecord[]): Promise<number> {
    let processed = 0;
    for (const event of events) {
      const checkpointKey = `${this.consumerName}:${event.accountId}`;
      const lastSequence = this.checkpoints.get(checkpointKey) ?? 0n;
      if (event.accountSequence <= lastSequence) continue;
      if (event.accountSequence !== lastSequence + 1n) break;
      if (!this.projected.has(event.eventId)) {
        await this.project(event);
        this.projected.add(event.eventId);
      }
      this.checkpoints.set(checkpointKey, event.accountSequence);
      await this.emitAfterCommit(event);
      processed += 1;
    }
    return processed;
  }

  checkpoint(accountId: string): bigint {
    return this.checkpoints.get(`${this.consumerName}:${accountId}`) ?? 0n;
  }
}
