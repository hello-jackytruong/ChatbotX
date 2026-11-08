import type { AccountLeaseService } from './account-lease.js';
import { Prisma } from '@prisma/client';

export type GatewayEventAppend = {
  eventId: string;
  accountId: string;
  ownerId: string;
  fenceToken: bigint;
  kind: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  providerEventId?: string | null;
};

export type GatewayEventRecord = GatewayEventAppend & {
  accountSequence: bigint;
  createdAt: Date;
};

export class GatewayEventOutbox {
  private readonly events = new Map<string, GatewayEventRecord>();
  private readonly sequences = new Map<string, bigint>();

  constructor(private readonly leases: AccountLeaseService) {}

  async append(input: GatewayEventAppend): Promise<GatewayEventRecord> {
    await this.leases.assertCurrent(input.accountId, input.ownerId, input.fenceToken);
    const existing = this.events.get(input.eventId);
    if (existing) return existing;
    const accountSequence = (this.sequences.get(input.accountId) ?? 0n) + 1n;
    const record = { ...input, accountSequence, createdAt: new Date() };
    this.sequences.set(input.accountId, accountSequence);
    this.events.set(input.eventId, record);
    return record;
  }

  list(accountId: string, afterSequence: bigint, limit: number): GatewayEventRecord[] {
    return [...this.events.values()]
      .filter((event) => event.accountId === accountId && event.accountSequence > afterSequence)
      .sort((left, right) => Number(left.accountSequence - right.accountSequence))
      .slice(0, limit);
  }
}

type EventRow = {
  event_id: string;
  account_id: string;
  account_sequence: bigint;
  fence_token: bigint;
  kind: string;
  provider_event_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
  created_at: Date;
};

type SqlClient = { $queryRaw<T>(query: Prisma.Sql): Promise<T> };
type TransactionClient = SqlClient & {
  $transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
};

function fromRow(row: EventRow, ownerId = ''): GatewayEventRecord {
  return {
    eventId: row.event_id,
    accountId: row.account_id,
    accountSequence: row.account_sequence,
    fenceToken: row.fence_token,
    ownerId,
    kind: row.kind,
    providerEventId: row.provider_event_id,
    payload: row.payload,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

export class PrismaGatewayEventOutbox {
  constructor(private readonly sql: TransactionClient) {}

  append(input: GatewayEventAppend): Promise<GatewayEventRecord> {
    return this.sql.$transaction(async (tx) => {
      const lease = await tx.$queryRaw<Array<{ account_id: string }>>(Prisma.sql`
        SELECT "account_id" FROM "gateway_account_leases"
        WHERE "account_id" = ${input.accountId}
          AND "owner_id" = ${input.ownerId}
          AND "fence_token" = ${input.fenceToken}
          AND "lease_until" > CURRENT_TIMESTAMP
        FOR UPDATE
      `);
      if (lease.length !== 1) throw new Error('STALE_FENCE');

      const sequences = await tx.$queryRaw<Array<{ next_sequence: bigint }>>(Prisma.sql`
        SELECT COALESCE(MAX("account_sequence"), 0) + 1 AS "next_sequence"
        FROM "gateway_event_outbox" WHERE "account_id" = ${input.accountId}
      `);
      const nextSequence = sequences[0]?.next_sequence ?? 1n;
      const inserted = await tx.$queryRaw<EventRow[]>(Prisma.sql`
        INSERT INTO "gateway_event_outbox"
          ("event_id", "account_id", "account_sequence", "fence_token", "kind", "version",
           "provider_event_id", "payload", "occurred_at")
        VALUES
          (${input.eventId}, ${input.accountId}, ${nextSequence}, ${input.fenceToken}, ${input.kind}, 1,
           ${input.providerEventId ?? null}, ${JSON.stringify(input.payload)}::jsonb, ${input.occurredAt})
        ON CONFLICT DO NOTHING
        RETURNING *
      `);
      if (inserted[0]) return fromRow(inserted[0], input.ownerId);
      const existing = await tx.$queryRaw<EventRow[]>(Prisma.sql`
        SELECT * FROM "gateway_event_outbox"
        WHERE "event_id" = ${input.eventId}
           OR (${input.providerEventId ?? null} IS NOT NULL
               AND "account_id" = ${input.accountId}
               AND "provider_event_id" = ${input.providerEventId ?? null})
        LIMIT 1
      `);
      if (!existing[0]) throw new Error('Gateway event conflict without an existing row');
      return fromRow(existing[0], input.ownerId);
    });
  }

  async list(accountId: string, afterSequence: bigint, limit: number): Promise<GatewayEventRecord[]> {
    const rows = await this.sql.$queryRaw<EventRow[]>(Prisma.sql`
      SELECT * FROM "gateway_event_outbox"
      WHERE "account_id" = ${accountId} AND "account_sequence" > ${afterSequence}
      ORDER BY "account_sequence" ASC
      LIMIT ${limit}
    `);
    return rows.map((row) => fromRow(row));
  }

  async bounds(accountId: string): Promise<{ highWaterMark: bigint; retentionFloor: bigint }> {
    const rows = await this.sql.$queryRaw<Array<{ high_water_mark: bigint; retention_floor: bigint }>>(Prisma.sql`
      SELECT
        COALESCE(MAX("account_sequence"), 0) AS "high_water_mark",
        COALESCE(MIN("account_sequence"), 0) AS "retention_floor"
      FROM "gateway_event_outbox"
      WHERE "account_id" = ${accountId}
    `);
    return {
      highWaterMark: rows[0]?.high_water_mark ?? 0n,
      retentionFloor: rows[0]?.retention_floor ?? 0n,
    };
  }
}
