import type { ProviderEventV1 } from './contracts.js';

type ProviderEventKind = ProviderEventV1['kind'];

export class ProviderEventProjector {
  private readonly epochs = new Map<string, number>();
  private readonly sequences = new Map<string, number>();

  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly eventId: (sequence: number, accountId: string) => string =
      (sequence, accountId) => `${accountId}:${sequence}`,
  ) {}

  beginEpoch(accountId: string): number {
    const epoch = (this.epochs.get(accountId) ?? 0) + 1;
    this.epochs.set(accountId, epoch);
    return epoch;
  }

  project(
    accountId: string,
    epoch: number,
    kind: ProviderEventKind,
    payload: Record<string, unknown>,
    providerIds: Record<string, string> = {},
  ): ProviderEventV1 | null {
    if (this.epochs.get(accountId) !== epoch) return null;
    const accountSequence = (this.sequences.get(accountId) ?? 0) + 1;
    this.sequences.set(accountId, accountSequence);
    return {
      version: 1,
      eventId: this.eventId(accountSequence, accountId),
      accountId,
      accountSequence,
      kind,
      occurredAt: this.now(),
      providerIds,
      payload,
    };
  }
}
