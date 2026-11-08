import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';

export type GatewayCommandStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'rejected'
  | 'failed'
  | 'unknown_outcome';

export type GatewayCommandInput = {
  commandId: string;
  accountId: string;
  idempotencyKey: string;
  kind: string;
  version: number;
  payload: Record<string, unknown>;
};

export type GatewayCommandRecord = GatewayCommandInput & {
  payloadHash: string;
  status: GatewayCommandStatus;
  result: unknown;
  error: string | null;
  attempts: number;
  availableAtMs: number;
  leaseOwner: string | null;
  leaseUntilMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}

function payloadHash(input: GatewayCommandInput): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ kind: input.kind, version: input.version, payload: input.payload })))
    .digest('hex');
}

export class GatewayCommandRepository {
  private readonly commands = new Map<string, GatewayCommandRecord>();
  private readonly idempotency = new Map<string, string>();
  private mutableNow: number;

  constructor(private readonly now: () => number = Date.now) {
    this.mutableNow = now();
  }

  advanceTo(nowMs: number): void {
    this.mutableNow = nowMs;
  }

  private currentTime(): number {
    return this.now === Date.now ? Date.now() : this.mutableNow;
  }

  async insert(input: GatewayCommandInput): Promise<{ created: boolean; command: GatewayCommandRecord }> {
    const key = `${input.accountId}:${input.idempotencyKey}`;
    const hash = payloadHash(input);
    const existingId = this.idempotency.get(key);
    if (existingId) {
      const existing = this.commands.get(existingId)!;
      if (existing.payloadHash !== hash) throw new Error('IDEMPOTENCY_CONFLICT');
      return { created: false, command: existing };
    }
    const now = this.currentTime();
    const command: GatewayCommandRecord = {
      ...input,
      payloadHash: hash,
      status: 'pending',
      result: null,
      error: null,
      attempts: 0,
      availableAtMs: now,
      leaseOwner: null,
      leaseUntilMs: null,
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.idempotency.set(key, input.commandId);
    this.commands.set(input.commandId, command);
    return { created: true, command };
  }

  async claim(ownerId: string, leaseMs: number, limit: number): Promise<GatewayCommandRecord[]> {
    const now = this.currentTime();
    const eligible = [...this.commands.values()]
      .filter((command) => command.availableAtMs <= now && (
        command.status === 'pending'
        || (command.status === 'processing' && (command.leaseUntilMs ?? 0) <= now)
      ))
      .sort((left, right) => left.createdAtMs - right.createdAtMs)
      .slice(0, limit);
    for (const command of eligible) {
      command.status = 'processing';
      command.leaseOwner = ownerId;
      command.leaseUntilMs = now + leaseMs;
      command.attempts += 1;
      command.updatedAtMs = now;
    }
    return eligible.map((command) => ({ ...command }));
  }

  async complete(
    commandId: string,
    ownerId: string,
    completion: Pick<GatewayCommandRecord, 'status' | 'result' | 'error'>,
  ): Promise<void> {
    const command = this.commands.get(commandId);
    if (!command || command.status !== 'processing' || command.leaseOwner !== ownerId) {
      throw new Error('STALE_COMMAND_LEASE');
    }
    command.status = completion.status;
    command.result = completion.result;
    command.error = completion.error;
    command.leaseOwner = null;
    command.leaseUntilMs = null;
    command.updatedAtMs = this.currentTime();
  }

  async get(commandId: string): Promise<GatewayCommandRecord | null> {
    const command = this.commands.get(commandId);
    return command ? { ...command } : null;
  }

  async reconcile(input: {
    accountId: string;
    commandId?: string;
    idempotencyKey?: string;
    providerMessageId?: string;
  }): Promise<GatewayCommandRecord | null> {
    const match = [...this.commands.values()].find((command) => {
      if (command.accountId !== input.accountId) return false;
      if (input.commandId && command.commandId === input.commandId) return true;
      if (input.idempotencyKey && command.idempotencyKey === input.idempotencyKey) return true;
      const providerId = (command.result as any)?.providerIds?.messageId;
      return Boolean(input.providerMessageId && providerId === input.providerMessageId);
    });
    return match ? { ...match } : null;
  }
}

type SqlClient = {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
};

type CommandRow = {
  command_id: string;
  account_id: string;
  idempotency_key: string;
  payload_hash: string;
  kind: string;
  version: number;
  payload: Record<string, unknown>;
  status: GatewayCommandStatus;
  result: unknown;
  error: unknown;
  attempts: number;
  available_at: Date;
  lease_owner: string | null;
  lease_until: Date | null;
  created_at: Date;
  updated_at: Date;
};

function fromRow(row: CommandRow): GatewayCommandRecord {
  return {
    commandId: row.command_id,
    accountId: row.account_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    kind: row.kind,
    version: row.version,
    payload: row.payload,
    status: row.status,
    result: row.result,
    error: row.error == null ? null : JSON.stringify(row.error),
    attempts: row.attempts,
    availableAtMs: row.available_at.getTime(),
    leaseOwner: row.lease_owner,
    leaseUntilMs: row.lease_until?.getTime() ?? null,
    createdAtMs: row.created_at.getTime(),
    updatedAtMs: row.updated_at.getTime(),
  };
}

export class PrismaGatewayCommandRepository {
  constructor(private readonly sql: SqlClient) {}

  async insert(input: GatewayCommandInput): Promise<{ created: boolean; command: GatewayCommandRecord }> {
    const hash = payloadHash(input);
    const rows = await this.sql.$queryRaw<CommandRow[]>(Prisma.sql`
      INSERT INTO "gateway_commands"
        ("command_id", "account_id", "idempotency_key", "payload_hash", "kind", "version", "payload", "updated_at")
      VALUES
        (${input.commandId}, ${input.accountId}, ${input.idempotencyKey}, ${hash}, ${input.kind}, ${input.version},
         ${JSON.stringify(input.payload)}::jsonb, CURRENT_TIMESTAMP)
      ON CONFLICT ("account_id", "idempotency_key") DO NOTHING
      RETURNING *
    `);
    if (rows[0]) return { created: true, command: fromRow(rows[0]) };
    const existing = await this.sql.$queryRaw<CommandRow[]>(Prisma.sql`
      SELECT * FROM "gateway_commands"
      WHERE "account_id" = ${input.accountId} AND "idempotency_key" = ${input.idempotencyKey}
    `);
    if (!existing[0]) throw new Error('Gateway command idempotency lookup failed');
    if (existing[0].payload_hash !== hash) throw new Error('IDEMPOTENCY_CONFLICT');
    return { created: false, command: fromRow(existing[0]) };
  }

  async claim(ownerId: string, leaseMs: number, limit: number): Promise<GatewayCommandRecord[]> {
    const rows = await this.sql.$queryRaw<CommandRow[]>(Prisma.sql`
      WITH candidates AS (
        SELECT c."command_id", l."fence_token"
        FROM "gateway_commands" c
        JOIN "gateway_account_leases" l ON l."account_id" = c."account_id"
        WHERE c."available_at" <= CURRENT_TIMESTAMP
          AND (c."status" = 'pending' OR (c."status" = 'processing' AND c."lease_until" <= CURRENT_TIMESTAMP))
          AND l."owner_id" = ${ownerId}
          AND l."lease_until" > CURRENT_TIMESTAMP
        ORDER BY c."created_at"
        FOR UPDATE OF c SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE "gateway_commands" c
      SET "status" = 'processing',
          "lease_owner" = ${ownerId},
          "lease_until" = CURRENT_TIMESTAMP + (${leaseMs} * INTERVAL '1 millisecond'),
          "fence_token" = candidates."fence_token",
          "attempts" = c."attempts" + 1,
          "updated_at" = CURRENT_TIMESTAMP
      FROM candidates
      WHERE c."command_id" = candidates."command_id"
      RETURNING c.*
    `);
    return rows.map(fromRow);
  }

  async complete(
    commandId: string,
    ownerId: string,
    completion: { status: GatewayCommandStatus; result: unknown; error: string | null },
  ): Promise<void> {
    const resultJson = completion.result == null ? null : JSON.stringify(completion.result);
    const errorJson = completion.error == null ? null : JSON.stringify({ code: completion.error });
    const rows = await this.sql.$queryRaw<Array<{ command_id: string }>>(Prisma.sql`
      UPDATE "gateway_commands" c
      SET "status" = ${completion.status},
          "result" = ${resultJson}::jsonb,
          "error" = ${errorJson}::jsonb,
          "lease_owner" = NULL,
          "lease_until" = NULL,
          "updated_at" = CURRENT_TIMESTAMP
      WHERE c."command_id" = ${commandId}
        AND c."status" = 'processing'
        AND c."lease_owner" = ${ownerId}
        AND EXISTS (
          SELECT 1 FROM "gateway_account_leases" l
          WHERE l."account_id" = c."account_id"
            AND l."owner_id" = ${ownerId}
            AND l."fence_token" = c."fence_token"
            AND l."lease_until" > CURRENT_TIMESTAMP
        )
      RETURNING c."command_id"
    `);
    if (rows.length !== 1) throw new Error('STALE_COMMAND_LEASE');
  }

  async get(commandId: string): Promise<GatewayCommandRecord | null> {
    const rows = await this.sql.$queryRaw<CommandRow[]>(Prisma.sql`
      SELECT * FROM "gateway_commands" WHERE "command_id" = ${commandId}
    `);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async reconcile(input: {
    accountId: string;
    commandId?: string;
    idempotencyKey?: string;
    providerMessageId?: string;
  }): Promise<GatewayCommandRecord | null> {
    const rows = await this.sql.$queryRaw<CommandRow[]>(Prisma.sql`
      SELECT * FROM "gateway_commands"
      WHERE "account_id" = ${input.accountId}
        AND (
          (${input.commandId ?? null} IS NOT NULL AND "command_id" = ${input.commandId ?? null})
          OR (${input.idempotencyKey ?? null} IS NOT NULL AND "idempotency_key" = ${input.idempotencyKey ?? null})
          OR (${input.providerMessageId ?? null} IS NOT NULL
              AND "result"->'providerIds'->>'messageId' = ${input.providerMessageId ?? null})
        )
      ORDER BY "created_at" DESC
      LIMIT 1
    `);
    return rows[0] ? fromRow(rows[0]) : null;
  }
}
