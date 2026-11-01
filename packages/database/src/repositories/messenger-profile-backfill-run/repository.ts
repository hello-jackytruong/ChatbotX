import {
  and,
  db,
  desc,
  eq,
  inArray,
  isUniqueViolationError,
  sql,
} from "../../client"
import { messengerProfileBackfillRunModel } from "../../schema"
import type { MessengerProfileBackfillRunModel } from "../../types"

export type MessengerProfileCandidate = {
  contactId: string
  contactInboxId: string
  sourceId: string
}

export const messengerProfileBackfillRunRepository = {
  async create(input: {
    workspaceId: string
    integrationMessengerId: string
    requestedByUserId: string | null
    policy: MessengerProfileBackfillRunModel["policy"]
  }): Promise<MessengerProfileBackfillRunModel | null> {
    try {
      const [row] = await db
        .insert(messengerProfileBackfillRunModel)
        .values(input)
        .returning()
      return row ?? null
    } catch (error) {
      if (
        isUniqueViolationError(error, "MessengerProfileBackfillRun_active_uq")
      ) {
        return null
      }
      throw error
    }
  },

  async findById(input: { workspaceId: string; runId: string }) {
    const [row] = await db
      .select()
      .from(messengerProfileBackfillRunModel)
      .where(
        and(
          eq(messengerProfileBackfillRunModel.id, input.runId),
          eq(messengerProfileBackfillRunModel.workspaceId, input.workspaceId),
        ),
      )
      .limit(1)
    return row ?? null
  },

  listHistory(input: { workspaceId: string; limit?: number }) {
    return db
      .select()
      .from(messengerProfileBackfillRunModel)
      .where(
        eq(messengerProfileBackfillRunModel.workspaceId, input.workspaceId),
      )
      .orderBy(desc(messengerProfileBackfillRunModel.id))
      .limit(input.limit ?? 30)
  },

  async claim(input: { workspaceId: string; runId: string }) {
    const [row] = await db
      .update(messengerProfileBackfillRunModel)
      .set({
        status: "running",
        startedAt: sql`COALESCE(${messengerProfileBackfillRunModel.startedAt}, NOW())`,
        lastHeartbeatAt: new Date(),
      })
      .where(
        and(
          eq(messengerProfileBackfillRunModel.id, input.runId),
          eq(messengerProfileBackfillRunModel.workspaceId, input.workspaceId),
          inArray(messengerProfileBackfillRunModel.status, ["init", "running"]),
        ),
      )
      .returning()
    return row ?? null
  },

  async listCandidates(input: {
    workspaceId: string
    inboxId: string
    cursorContactInboxId: string | null
    limit: number
  }): Promise<MessengerProfileCandidate[]> {
    const result = await db.execute<MessengerProfileCandidate>(sql`
      SELECT
        c.id::text AS "contactId",
        ci.id::text AS "contactInboxId",
        ci."sourceId" AS "sourceId"
      FROM "ContactInbox" ci
      INNER JOIN "Contact" c ON c.id = ci."contactId"
      WHERE ci."inboxId" = ${input.inboxId}
        AND c."workspaceId" = ${input.workspaceId}
        AND (${input.cursorContactInboxId}::bigint IS NULL OR ci.id > ${input.cursorContactInboxId}::bigint)
        AND (
          c."firstName" IS NULL OR btrim(c."firstName") = '' OR
          c."lastName" IS NULL OR btrim(c."lastName") = '' OR
          c.gender IS NULL OR c.avatar IS NULL OR c.avatar = '' OR
          c.avatar LIKE 'public/img/no_avatar.jpg?time=%'
        )
      ORDER BY ci.id ASC
      LIMIT ${input.limit}
    `)
    return [...result.rows]
  },

  async fillMissingProfile(input: {
    workspaceId: string
    contactId: string
    firstName?: string
    lastName?: string
    gender?: "male" | "female" | "unknown"
    avatar?: string
  }): Promise<{ updated: boolean; avatarUpdated: boolean }> {
    const result = await db.execute<{ avatarUpdated: boolean }>(sql`
      UPDATE "Contact"
      SET
        "firstName" = CASE WHEN "firstName" IS NULL OR btrim("firstName") = '' THEN COALESCE(${input.firstName ?? null}, "firstName") ELSE "firstName" END,
        "lastName" = CASE WHEN "lastName" IS NULL OR btrim("lastName") = '' THEN COALESCE(${input.lastName ?? null}, "lastName") ELSE "lastName" END,
        gender = CASE WHEN gender IS NULL THEN COALESCE(${input.gender ?? null}::gender, gender) ELSE gender END,
        avatar = CASE WHEN avatar IS NULL OR avatar = '' OR avatar LIKE 'public/img/no_avatar.jpg?time=%' THEN COALESCE(${input.avatar ?? null}, avatar) ELSE avatar END,
        "updatedAt" = NOW()
      WHERE id = ${input.contactId}
        AND "workspaceId" = ${input.workspaceId}
        AND (
          (${input.firstName ?? null}::text IS NOT NULL AND ("firstName" IS NULL OR btrim("firstName") = '')) OR
          (${input.lastName ?? null}::text IS NOT NULL AND ("lastName" IS NULL OR btrim("lastName") = '')) OR
          (${input.gender ?? null}::text IS NOT NULL AND gender IS NULL) OR
          (${input.avatar ?? null}::text IS NOT NULL AND (avatar IS NULL OR avatar = '' OR avatar LIKE 'public/img/no_avatar.jpg?time=%'))
        )
      RETURNING (${input.avatar ?? null}::text IS NOT NULL) AS "avatarUpdated"
    `)
    return {
      updated: result.rows.length > 0,
      avatarUpdated: result.rows[0]?.avatarUpdated ?? false,
    }
  },

  async updateProgress(input: {
    workspaceId: string
    runId: string
    cursorContactInboxId: string
    scanned: number
    updated: number
    avatars: number
    skipped: number
    failed: number
  }): Promise<void> {
    await db
      .update(messengerProfileBackfillRunModel)
      .set({
        cursorContactInboxId: input.cursorContactInboxId,
        currentScan: sql`${messengerProfileBackfillRunModel.currentScan} + ${input.scanned}`,
        updatedCount: sql`${messengerProfileBackfillRunModel.updatedCount} + ${input.updated}`,
        avatarCount: sql`${messengerProfileBackfillRunModel.avatarCount} + ${input.avatars}`,
        skippedCount: sql`${messengerProfileBackfillRunModel.skippedCount} + ${input.skipped}`,
        failedCount: sql`${messengerProfileBackfillRunModel.failedCount} + ${input.failed}`,
        lastHeartbeatAt: new Date(),
      })
      .where(
        and(
          eq(messengerProfileBackfillRunModel.id, input.runId),
          eq(messengerProfileBackfillRunModel.workspaceId, input.workspaceId),
          eq(messengerProfileBackfillRunModel.status, "running"),
        ),
      )
  },

  async requestCancel(input: { workspaceId: string; runId: string }) {
    const rows = await db
      .update(messengerProfileBackfillRunModel)
      .set({ cancelRequestedAt: new Date() })
      .where(
        and(
          eq(messengerProfileBackfillRunModel.id, input.runId),
          eq(messengerProfileBackfillRunModel.workspaceId, input.workspaceId),
        ),
      )
      .returning({ id: messengerProfileBackfillRunModel.id })
    return rows.length > 0
  },

  async finish(input: {
    workspaceId: string
    runId: string
    status: "succeeded" | "partial" | "failed" | "cancelled"
    currentError?: string | null
  }): Promise<void> {
    await db
      .update(messengerProfileBackfillRunModel)
      .set({
        status: input.status,
        currentError: input.currentError ?? null,
        finishedAt: new Date(),
        lastHeartbeatAt: new Date(),
      })
      .where(
        and(
          eq(messengerProfileBackfillRunModel.id, input.runId),
          eq(messengerProfileBackfillRunModel.workspaceId, input.workspaceId),
        ),
      )
  },
}
