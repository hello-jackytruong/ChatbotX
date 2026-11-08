import type { Server } from 'socket.io';
import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';

type SocketEventRecord = {
  accountSequence: bigint;
  kind: string;
  payload: Record<string, unknown>;
};

type FacadeEventRepository = {
  claimBatch(consumerName: string, accountId: string, limit: number): Promise<SocketEventRecord[]>;
  checkpoint(consumerName: string, accountId: string, sequence: bigint): Promise<void>;
  listAccounts(limit: number): Promise<string[]>;
};

type SqlClient = { $queryRaw<T>(query: Prisma.Sql): Promise<T> };
type TransactionClient = SqlClient & {
  $transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
};

type EventRow = {
  account_sequence: bigint;
  kind: string;
  payload: Record<string, unknown>;
};

export class PrismaFacadeEventRepository implements FacadeEventRepository {
  constructor(private readonly sql: TransactionClient) {}

  async listAccounts(limit: number): Promise<string[]> {
    const rows = await this.sql.$queryRaw<Array<{ account_id: string }>>(Prisma.sql`
      SELECT DISTINCT e."account_id"
      FROM "gateway_event_outbox" e
      LEFT JOIN "gateway_consumer_checkpoints" c
        ON c."consumer_name" = 'zalo-personal-facade' AND c."account_id" = e."account_id"
      WHERE e."account_sequence" > COALESCE(c."last_sequence", 0)
      ORDER BY e."account_id"
      LIMIT ${limit}
    `);
    return rows.map((row) => row.account_id);
  }

  claimBatch(consumerName: string, accountId: string, limit: number): Promise<SocketEventRecord[]> {
    return this.sql.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        INSERT INTO "gateway_consumer_checkpoints"
          ("consumer_name", "account_id", "last_sequence", "updated_at")
        VALUES (${consumerName}, ${accountId}, 0, CURRENT_TIMESTAMP)
        ON CONFLICT ("consumer_name", "account_id") DO NOTHING
      `);
      const checkpoints = await tx.$queryRaw<Array<{ last_sequence: bigint }>>(Prisma.sql`
        SELECT "last_sequence" FROM "gateway_consumer_checkpoints"
        WHERE "consumer_name" = ${consumerName} AND "account_id" = ${accountId}
        FOR UPDATE
      `);
      const lastSequence = checkpoints[0]?.last_sequence ?? 0n;
      const rows = await tx.$queryRaw<EventRow[]>(Prisma.sql`
        SELECT "account_sequence", "kind", "payload"
        FROM "gateway_event_outbox"
        WHERE "account_id" = ${accountId} AND "account_sequence" > ${lastSequence}
        ORDER BY "account_sequence" ASC
        LIMIT ${limit}
      `);
      const contiguous: EventRow[] = [];
      let expected = lastSequence + 1n;
      for (const row of rows) {
        if (row.account_sequence !== expected) break;
        contiguous.push(row);
        expected += 1n;
      }
      return contiguous.map((row) => ({
        accountSequence: row.account_sequence,
        kind: row.kind,
        payload: row.payload,
      }));
    });
  }

  async checkpoint(consumerName: string, accountId: string, sequence: bigint): Promise<void> {
    await this.sql.$queryRaw(Prisma.sql`
      UPDATE "gateway_consumer_checkpoints"
      SET "last_sequence" = GREATEST("last_sequence", ${sequence}),
          "updated_at" = CURRENT_TIMESTAMP
      WHERE "consumer_name" = ${consumerName} AND "account_id" = ${accountId}
    `);
  }
}

export class GatewayFacadeSocketConsumer {
  constructor(
    private readonly repository: FacadeEventRepository,
    private readonly io: Server,
    private readonly consumerName = 'zalo-personal-facade',
    private readonly batchSize = 100,
  ) {}

  async runOnce(): Promise<number> {
    let count = 0;
    for (const accountId of await this.repository.listAccounts(100)) {
      const events = await this.repository.claimBatch(this.consumerName, accountId, this.batchSize);
      for (const event of events) {
        const room = typeof event.payload.room === 'string' ? event.payload.room : null;
        const name = event.payload.event;
        if (typeof name === 'string') {
          if (room) this.io.to(room).emit(name, event.payload.payload);
          else this.io.emit(name, event.payload.payload);
          count += 1;
        }
        await this.repository.checkpoint(this.consumerName, accountId, event.accountSequence);
      }
    }
    return count;
  }
}

export function startGatewayFacadeSocketConsumer(io: Server, intervalMs = 100): NodeJS.Timeout {
  const consumer = new GatewayFacadeSocketConsumer(
    new PrismaFacadeEventRepository(prisma as never),
    io,
  );
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await consumer.runOnce();
    } catch (err) {
      logger.warn('[zalo-facade] gateway event consumer failed', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return timer;
}
