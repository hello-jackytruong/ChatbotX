export type AccountLease = {
  accountId: string;
  ownerId: string;
  fenceToken: bigint;
  leaseUntilMs: number;
  heartbeatAtMs: number;
};

export type LeaseAcquireResult = AccountLease & { acquired: boolean };

export interface AccountLeaseStore {
  acquire(accountId: string, ownerId: string, ttlMs: number): Promise<LeaseAcquireResult>;
  current(accountId: string): Promise<AccountLease | null>;
  isCurrent(accountId: string, ownerId: string, fenceToken: bigint): Promise<boolean>;
  heartbeat(accountId: string, ownerId: string, fenceToken: bigint, ttlMs: number): Promise<boolean>;
  release(accountId: string, ownerId: string, fenceToken: bigint): Promise<boolean>;
}

export class InMemoryAccountLeaseStore implements AccountLeaseStore {
  private readonly leases = new Map<string, AccountLease>();
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

  async acquire(accountId: string, ownerId: string, ttlMs: number): Promise<LeaseAcquireResult> {
    const now = this.currentTime();
    const existing = this.leases.get(accountId);
    if (existing && existing.leaseUntilMs > now && existing.ownerId !== ownerId) {
      return { ...existing, acquired: false };
    }
    const fenceToken = existing && existing.ownerId === ownerId && existing.leaseUntilMs > now
      ? existing.fenceToken
      : (existing?.fenceToken ?? 0n) + 1n;
    const lease: AccountLease = {
      accountId,
      ownerId,
      fenceToken,
      leaseUntilMs: now + ttlMs,
      heartbeatAtMs: now,
    };
    this.leases.set(accountId, lease);
    return { ...lease, acquired: true };
  }

  async current(accountId: string): Promise<AccountLease | null> {
    return this.leases.get(accountId) ?? null;
  }

  async heartbeat(
    accountId: string,
    ownerId: string,
    fenceToken: bigint,
    ttlMs: number,
  ): Promise<boolean> {
    const now = this.currentTime();
    const existing = this.leases.get(accountId);
    if (!existing || existing.ownerId !== ownerId || existing.fenceToken !== fenceToken || existing.leaseUntilMs <= now) {
      return false;
    }
    this.leases.set(accountId, { ...existing, heartbeatAtMs: now, leaseUntilMs: now + ttlMs });
    return true;
  }

  async isCurrent(accountId: string, ownerId: string, fenceToken: bigint): Promise<boolean> {
    const existing = this.leases.get(accountId);
    return Boolean(
      existing
      && existing.ownerId === ownerId
      && existing.fenceToken === fenceToken
      && existing.leaseUntilMs > this.currentTime(),
    );
  }

  async release(accountId: string, ownerId: string, fenceToken: bigint): Promise<boolean> {
    const existing = this.leases.get(accountId);
    if (!existing || existing.ownerId !== ownerId || existing.fenceToken !== fenceToken) return false;
    this.leases.set(accountId, { ...existing, leaseUntilMs: this.currentTime() });
    return true;
  }
}

export class AccountLeaseService {
  constructor(
    private readonly store: AccountLeaseStore,
    private readonly ttlMs: number,
  ) {}

  acquire(accountId: string, ownerId: string): Promise<LeaseAcquireResult> {
    return this.store.acquire(accountId, ownerId, this.ttlMs);
  }

  heartbeat(accountId: string, ownerId: string, fenceToken: bigint): Promise<boolean> {
    return this.store.heartbeat(accountId, ownerId, fenceToken, this.ttlMs);
  }

  release(accountId: string, ownerId: string, fenceToken: bigint): Promise<boolean> {
    return this.store.release(accountId, ownerId, fenceToken);
  }

  async assertCurrent(accountId: string, ownerId: string, fenceToken: bigint): Promise<void> {
    if (!await this.store.isCurrent(accountId, ownerId, fenceToken)) {
      throw new Error('STALE_FENCE');
    }
  }
}
import { Prisma } from '@prisma/client';


type LeaseRow = {
  account_id: string;
  owner_id: string;
  fence_token: bigint;
  lease_until: Date;
  heartbeat_at: Date;
};

type SqlClient = {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
};

function fromRow(row: LeaseRow): AccountLease {
  return {
    accountId: row.account_id,
    ownerId: row.owner_id,
    fenceToken: row.fence_token,
    leaseUntilMs: row.lease_until.getTime(),
    heartbeatAtMs: row.heartbeat_at.getTime(),
  };
}

export class PrismaAccountLeaseStore implements AccountLeaseStore {
  constructor(private readonly sql: SqlClient) {}

  async acquire(accountId: string, ownerId: string, ttlMs: number): Promise<LeaseAcquireResult> {
    const rows = await this.sql.$queryRaw<LeaseRow[]>(Prisma.sql`
      INSERT INTO "gateway_account_leases"
        ("account_id", "owner_id", "fence_token", "lease_until", "heartbeat_at", "updated_at")
      VALUES
        (${accountId}, ${ownerId}, 1, CURRENT_TIMESTAMP + (${ttlMs} * INTERVAL '1 millisecond'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("account_id") DO UPDATE SET
        "owner_id" = EXCLUDED."owner_id",
        "fence_token" = CASE
          WHEN "gateway_account_leases"."owner_id" = EXCLUDED."owner_id"
            AND "gateway_account_leases"."lease_until" > CURRENT_TIMESTAMP
          THEN "gateway_account_leases"."fence_token"
          ELSE "gateway_account_leases"."fence_token" + 1
        END,
        "lease_until" = EXCLUDED."lease_until",
        "heartbeat_at" = CURRENT_TIMESTAMP,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "gateway_account_leases"."owner_id" = EXCLUDED."owner_id"
         OR "gateway_account_leases"."lease_until" <= CURRENT_TIMESTAMP
      RETURNING "account_id", "owner_id", "fence_token", "lease_until", "heartbeat_at"
    `);
    if (rows[0]) return { ...fromRow(rows[0]), acquired: true };
    const current = await this.current(accountId);
    if (!current) throw new Error('Gateway lease disappeared during acquisition');
    return { ...current, acquired: false };
  }

  async current(accountId: string): Promise<AccountLease | null> {
    const rows = await this.sql.$queryRaw<LeaseRow[]>(Prisma.sql`
      SELECT "account_id", "owner_id", "fence_token", "lease_until", "heartbeat_at"
      FROM "gateway_account_leases" WHERE "account_id" = ${accountId}
    `);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async heartbeat(accountId: string, ownerId: string, fenceToken: bigint, ttlMs: number): Promise<boolean> {
    const rows = await this.sql.$queryRaw<Array<{ account_id: string }>>(Prisma.sql`
      UPDATE "gateway_account_leases"
      SET "lease_until" = CURRENT_TIMESTAMP + (${ttlMs} * INTERVAL '1 millisecond'),
          "heartbeat_at" = CURRENT_TIMESTAMP,
          "updated_at" = CURRENT_TIMESTAMP
      WHERE "account_id" = ${accountId}
        AND "owner_id" = ${ownerId}
        AND "fence_token" = ${fenceToken}
        AND "lease_until" > CURRENT_TIMESTAMP
      RETURNING "account_id"
    `);
    return rows.length === 1;
  }

  async isCurrent(accountId: string, ownerId: string, fenceToken: bigint): Promise<boolean> {
    const rows = await this.sql.$queryRaw<Array<{ account_id: string }>>(Prisma.sql`
      SELECT "account_id" FROM "gateway_account_leases"
      WHERE "account_id" = ${accountId}
        AND "owner_id" = ${ownerId}
        AND "fence_token" = ${fenceToken}
        AND "lease_until" > CURRENT_TIMESTAMP
    `);
    return rows.length === 1;
  }

  async release(accountId: string, ownerId: string, fenceToken: bigint): Promise<boolean> {
    const rows = await this.sql.$queryRaw<Array<{ account_id: string }>>(Prisma.sql`
      UPDATE "gateway_account_leases"
      SET "lease_until" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
      WHERE "account_id" = ${accountId} AND "owner_id" = ${ownerId} AND "fence_token" = ${fenceToken}
      RETURNING "account_id"
    `);
    return rows.length === 1;
  }
}
