import { sql } from "drizzle-orm"
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import {
  type ZaloPersonalBridgeDirection,
  type ZaloPersonalCommandStatus,
  zaloPersonalBridgeDirections,
  zaloPersonalCommandStatuses,
} from "../partials/zalo-personal-bridge"
import { contactModel } from "./contact"
import { conversationModel } from "./conversation"
import { inboxModel } from "./inbox"
import { integrationZaloPersonalModel } from "./integration-zalo-personal"
import { workspaceModel } from "./workspace"

export const zaloPersonalCommandStatus = pgEnum(
  "zaloPersonalCommandStatus",
  zaloPersonalCommandStatuses.options as [
    ZaloPersonalCommandStatus,
    ...ZaloPersonalCommandStatus[],
  ],
)

export const zaloPersonalBridgeDirection = pgEnum(
  "zaloPersonalBridgeDirection",
  zaloPersonalBridgeDirections.options as [
    ZaloPersonalBridgeDirection,
    ...ZaloPersonalBridgeDirection[],
  ],
)

export const zaloPersonalCommandOutboxModel = pgTable(
  "ZaloPersonalCommandOutbox",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    integrationId: bigintAsString()
      .notNull()
      .references(() => integrationZaloPersonalModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    inboxId: bigintAsString()
      .notNull()
      .references(() => inboxModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    messageId: bigintAsString().notNull(),
    accountId: text().notNull(),
    commandId: text().notNull(),
    idempotencyKey: text().notNull(),
    payloadHash: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    status: zaloPersonalCommandStatus().default("pending").notNull(),
    providerMessageId: text(),
    attempts: integer().default(0).notNull(),
    leaseOwner: text(),
    leaseUntil: timestamp(timestampConfig),
    nextAttemptAt: timestamp(timestampConfig).defaultNow().notNull(),
    lastError: text(),
  },
  (table) => [
    index("ZaloPersonalCommandOutbox_workspaceId_idx").on(table.workspaceId),
    index("ZaloPersonalCommandOutbox_integrationId_idx").on(
      table.integrationId,
    ),
    index("ZaloPersonalCommandOutbox_inboxId_idx").on(table.inboxId),
    index("ZaloPersonalCommandOutbox_status_nextAttemptAt_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    uniqueIndex("ZaloPersonalCommandOutbox_commandId_key").on(table.commandId),
    uniqueIndex("ZaloPersonalCommandOutbox_workspaceId_messageId_key").on(
      table.workspaceId,
      table.messageId,
    ),
  ],
)

export const zaloPersonalBridgeCheckpointModel = pgTable(
  "ZaloPersonalBridgeCheckpoint",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    integrationId: bigintAsString()
      .notNull()
      .references(() => integrationZaloPersonalModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    accountId: text().notNull(),
    lastSequence: bigintAsString().default(sql`0`).notNull(),
    lastFenceToken: bigintAsString().default(sql`0`).notNull(),
  },
  (table) => [
    index("ZaloPersonalBridgeCheckpoint_workspaceId_idx").on(table.workspaceId),
    index("ZaloPersonalBridgeCheckpoint_integrationId_idx").on(
      table.integrationId,
    ),
    uniqueIndex("ZaloPersonalBridgeCheckpoint_integrationId_accountId_key").on(
      table.integrationId,
      table.accountId,
    ),
  ],
)

export const zaloPersonalThreadMappingModel = pgTable(
  "ZaloPersonalThreadMapping",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    inboxId: bigintAsString()
      .notNull()
      .references(() => inboxModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    accountId: text().notNull(),
    providerThreadId: text().notNull(),
    conversationId: bigintAsString()
      .notNull()
      .references(() => conversationModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
  },
  (table) => [
    index("ZaloPersonalThreadMapping_workspaceId_idx").on(table.workspaceId),
    index("ZaloPersonalThreadMapping_inboxId_idx").on(table.inboxId),
    index("ZaloPersonalThreadMapping_conversationId_idx").on(
      table.conversationId,
    ),
    uniqueIndex("ZaloPersonalThreadMapping_scope_provider_key").on(
      table.workspaceId,
      table.inboxId,
      table.accountId,
      table.providerThreadId,
    ),
    uniqueIndex("ZaloPersonalThreadMapping_scope_conversation_key").on(
      table.workspaceId,
      table.inboxId,
      table.accountId,
      table.conversationId,
    ),
  ],
)

export const zaloPersonalContactMappingModel = pgTable(
  "ZaloPersonalContactMapping",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    inboxId: bigintAsString()
      .notNull()
      .references(() => inboxModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    accountId: text().notNull(),
    providerContactId: text().notNull(),
    contactId: bigintAsString()
      .notNull()
      .references(() => contactModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
  },
  (table) => [
    index("ZaloPersonalContactMapping_workspaceId_idx").on(table.workspaceId),
    index("ZaloPersonalContactMapping_inboxId_idx").on(table.inboxId),
    index("ZaloPersonalContactMapping_contactId_idx").on(table.contactId),
    uniqueIndex("ZaloPersonalContactMapping_scope_provider_key").on(
      table.workspaceId,
      table.inboxId,
      table.accountId,
      table.providerContactId,
    ),
    uniqueIndex("ZaloPersonalContactMapping_scope_contact_key").on(
      table.workspaceId,
      table.inboxId,
      table.accountId,
      table.contactId,
    ),
  ],
)

export const zaloPersonalMessageMappingModel = pgTable(
  "ZaloPersonalMessageMapping",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    inboxId: bigintAsString()
      .notNull()
      .references(() => inboxModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    accountId: text().notNull(),
    providerMessageId: text().notNull(),
    providerClientMessageId: text(),
    messageId: bigintAsString().notNull(),
    direction: zaloPersonalBridgeDirection().notNull(),
  },
  (table) => [
    index("ZaloPersonalMessageMapping_workspaceId_idx").on(table.workspaceId),
    index("ZaloPersonalMessageMapping_inboxId_idx").on(table.inboxId),
    index("ZaloPersonalMessageMapping_messageId_idx").on(table.messageId),
    uniqueIndex("ZaloPersonalMessageMapping_scope_provider_key").on(
      table.workspaceId,
      table.inboxId,
      table.accountId,
      table.providerMessageId,
    ),
    uniqueIndex("ZaloPersonalMessageMapping_scope_message_key").on(
      table.workspaceId,
      table.inboxId,
      table.accountId,
      table.messageId,
    ),
  ],
)

export const zaloPersonalBridgeDeadLetterModel = pgTable(
  "ZaloPersonalBridgeDeadLetter",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    integrationId: bigintAsString()
      .notNull()
      .references(() => integrationZaloPersonalModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    inboxId: bigintAsString()
      .notNull()
      .references(() => inboxModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    accountId: text().notNull(),
    direction: zaloPersonalBridgeDirection().notNull(),
    eventId: text(),
    commandId: text(),
    errorCode: text().notNull(),
    payloadDigest: text().notNull(),
    attempts: integer().default(0).notNull(),
    nextAttemptAt: timestamp(timestampConfig),
    resolvedAt: timestamp(timestampConfig),
  },
  (table) => [
    index("ZaloPersonalBridgeDeadLetter_workspaceId_idx").on(table.workspaceId),
    index("ZaloPersonalBridgeDeadLetter_integrationId_idx").on(
      table.integrationId,
    ),
    index("ZaloPersonalBridgeDeadLetter_inboxId_idx").on(table.inboxId),
    index("ZaloPersonalBridgeDeadLetter_retry_idx").on(
      table.resolvedAt,
      table.nextAttemptAt,
    ),
  ],
)
