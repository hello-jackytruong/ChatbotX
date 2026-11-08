import { and, type DatabaseClient, db, eq } from "@chatbotx.io/database/client"
import {
  zaloPersonalBridgeCheckpointModel,
  zaloPersonalBridgeDeadLetterModel,
  zaloPersonalCommandOutboxModel,
  zaloPersonalContactMappingModel,
  zaloPersonalMessageMappingModel,
  zaloPersonalThreadMappingModel,
} from "@chatbotx.io/database/schema"

export type InboundBridgeCommit = {
  workspaceId: string
  integrationId: string
  inboxId: string
  accountId: string
  sequence: string
  fenceToken: string
  thread?: { providerId: string; conversationId: string }
  contact?: { providerId: string; contactId: string }
  message?: {
    providerId: string
    providerClientId?: string | null
    messageId: string
    direction: "inbound" | "outbound"
  }
}

export class BridgeSequenceGapError extends Error {
  readonly expected: string
  readonly received: string

  constructor(expected: string, received: string) {
    super("ZALO_PERSONAL_BRIDGE_SEQUENCE_GAP")
    this.name = "BridgeSequenceGapError"
    this.expected = expected
    this.received = received
  }
}

export class BridgeMappingConflictError extends Error {
  readonly mappingType: "thread" | "contact" | "message"

  constructor(mappingType: "thread" | "contact" | "message") {
    super("ZALO_PERSONAL_BRIDGE_MAPPING_CONFLICT")
    this.name = "BridgeMappingConflictError"
    this.mappingType = mappingType
  }
}

async function assertThreadMapping(
  tx: DatabaseClient,
  input: InboundBridgeCommit,
): Promise<void> {
  if (!input.thread) {
    return
  }
  await tx
    .insert(zaloPersonalThreadMappingModel)
    .values({
      workspaceId: input.workspaceId,
      inboxId: input.inboxId,
      accountId: input.accountId,
      providerThreadId: input.thread.providerId,
      conversationId: input.thread.conversationId,
    })
    .onConflictDoNothing()
  const row = await tx.query.zaloPersonalThreadMappingModel.findFirst({
    where: {
      workspaceId: input.workspaceId,
      inboxId: input.inboxId,
      accountId: input.accountId,
      providerThreadId: input.thread.providerId,
    },
    columns: { conversationId: true },
  })
  if (row?.conversationId !== input.thread.conversationId) {
    throw new BridgeMappingConflictError("thread")
  }
}

async function assertContactMapping(
  tx: DatabaseClient,
  input: InboundBridgeCommit,
): Promise<void> {
  if (!input.contact) {
    return
  }
  await tx
    .insert(zaloPersonalContactMappingModel)
    .values({
      workspaceId: input.workspaceId,
      inboxId: input.inboxId,
      accountId: input.accountId,
      providerContactId: input.contact.providerId,
      contactId: input.contact.contactId,
    })
    .onConflictDoNothing()
  const row = await tx.query.zaloPersonalContactMappingModel.findFirst({
    where: {
      workspaceId: input.workspaceId,
      inboxId: input.inboxId,
      accountId: input.accountId,
      providerContactId: input.contact.providerId,
    },
    columns: { contactId: true },
  })
  if (row?.contactId !== input.contact.contactId) {
    throw new BridgeMappingConflictError("contact")
  }
}

async function assertMessageMapping(
  tx: DatabaseClient,
  input: InboundBridgeCommit,
): Promise<void> {
  if (!input.message) {
    return
  }
  await tx
    .insert(zaloPersonalMessageMappingModel)
    .values({
      workspaceId: input.workspaceId,
      inboxId: input.inboxId,
      accountId: input.accountId,
      providerMessageId: input.message.providerId,
      providerClientMessageId: input.message.providerClientId ?? null,
      messageId: input.message.messageId,
      direction: input.message.direction,
    })
    .onConflictDoNothing()
  const row = await tx.query.zaloPersonalMessageMappingModel.findFirst({
    where: {
      workspaceId: input.workspaceId,
      inboxId: input.inboxId,
      accountId: input.accountId,
      providerMessageId: input.message.providerId,
    },
    columns: { messageId: true },
  })
  if (row?.messageId !== input.message.messageId) {
    throw new BridgeMappingConflictError("message")
  }
}

export class ZaloPersonalBridgeRepository {
  async createOutbound(input: {
    workspaceId: string
    integrationId: string
    inboxId: string
    messageId: string
    accountId: string
    commandId: string
    idempotencyKey: string
    payloadHash: string
    payload: Record<string, unknown>
  }) {
    await db
      .insert(zaloPersonalCommandOutboxModel)
      .values({
        ...input,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
      })
      .onConflictDoNothing()
    const row = await db.query.zaloPersonalCommandOutboxModel.findFirst({
      where: { workspaceId: input.workspaceId, messageId: input.messageId },
    })
    if (!row) {
      throw new Error("ZALO_PERSONAL_OUTBOX_INSERT_FAILED")
    }
    if (
      row.payloadHash !== input.payloadHash ||
      row.commandId !== input.commandId
    ) {
      throw new Error("ZALO_PERSONAL_OUTBOX_IDEMPOTENCY_CONFLICT")
    }
    return row
  }

  commitInbound(
    input: InboundBridgeCommit,
  ): Promise<"committed" | "duplicate"> {
    return db.transaction(async (tx) => {
      const current =
        await tx.query.zaloPersonalBridgeCheckpointModel.findFirst({
          where: {
            workspaceId: input.workspaceId,
            integrationId: input.integrationId,
            accountId: input.accountId,
          },
        })
      const last = BigInt(current?.lastSequence ?? "0")
      const received = BigInt(input.sequence)
      if (received <= last) {
        return "duplicate"
      }
      if (received !== last + 1n) {
        throw new BridgeSequenceGapError(String(last + 1n), input.sequence)
      }
      await assertThreadMapping(tx, input)
      await assertContactMapping(tx, input)
      await assertMessageMapping(tx, input)
      await tx
        .insert(zaloPersonalBridgeCheckpointModel)
        .values({
          workspaceId: input.workspaceId,
          integrationId: input.integrationId,
          accountId: input.accountId,
          lastSequence: input.sequence,
          lastFenceToken: input.fenceToken,
        })
        .onConflictDoUpdate({
          target: [
            zaloPersonalBridgeCheckpointModel.integrationId,
            zaloPersonalBridgeCheckpointModel.accountId,
          ],
          set: {
            lastSequence: input.sequence,
            lastFenceToken: input.fenceToken,
            updatedAt: new Date(),
          },
        })
      return "committed"
    })
  }

  addDeadLetter(input: {
    workspaceId: string
    integrationId: string
    inboxId: string
    accountId: string
    direction: "inbound" | "outbound"
    eventId?: string
    commandId?: string
    errorCode: string
    payloadDigest: string
  }): Promise<void> {
    return db
      .insert(zaloPersonalBridgeDeadLetterModel)
      .values({
        ...input,
        attempts: 0,
      })
      .then(() => undefined)
  }

  getOutbound(input: { workspaceId: string; commandId: string }) {
    return db.query.zaloPersonalCommandOutboxModel.findFirst({
      where: {
        workspaceId: input.workspaceId,
        commandId: input.commandId,
      },
    })
  }

  async updateOutbound(input: {
    id: string
    workspaceId: string
    status: "pending" | "succeeded" | "failed" | "unknown_outcome"
    providerMessageId?: string | null
    lastError?: string | null
    incrementAttempts?: boolean
  }): Promise<void> {
    const current = await db.query.zaloPersonalCommandOutboxModel.findFirst({
      where: { id: input.id, workspaceId: input.workspaceId },
      columns: { attempts: true },
    })
    if (!current) {
      throw new Error("ZALO_PERSONAL_OUTBOX_NOT_FOUND")
    }
    await db
      .update(zaloPersonalCommandOutboxModel)
      .set({
        status: input.status,
        providerMessageId: input.providerMessageId,
        lastError: input.lastError,
        attempts: current.attempts + (input.incrementAttempts ? 1 : 0),
        nextAttemptAt: new Date(Date.now() + 5000),
      })
      .where(
        and(
          eq(zaloPersonalCommandOutboxModel.id, input.id),
          eq(zaloPersonalCommandOutboxModel.workspaceId, input.workspaceId),
        ),
      )
  }

  getCheckpoint(input: { integrationId: string; accountId: string }) {
    return db.query.zaloPersonalBridgeCheckpointModel.findFirst({
      where: input,
    })
  }
}

export const zaloPersonalBridgeRepository = new ZaloPersonalBridgeRepository()
