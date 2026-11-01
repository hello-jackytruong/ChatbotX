import { sql } from "drizzle-orm"
import {
  index,
  integer,
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
import { userModel } from "./auth-user"
import { integrationMessengerModel } from "./integration-messenger"
import { workspaceModel } from "./workspace"

export const messengerProfileBackfillPolicy = pgEnum(
  "messengerProfileBackfillPolicy",
  ["pancake", "meta", "pancakeThenMeta"],
)
export const messengerProfileBackfillStatus = pgEnum(
  "messengerProfileBackfillStatus",
  ["init", "running", "succeeded", "partial", "failed", "cancelled"],
)

export const messengerProfileBackfillRunModel = pgTable(
  "MessengerProfileBackfillRun",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    integrationMessengerId: bigintAsString()
      .notNull()
      .references(() => integrationMessengerModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    requestedByUserId: bigintAsString().references(() => userModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    policy: messengerProfileBackfillPolicy().notNull().default("pancake"),
    status: messengerProfileBackfillStatus().notNull().default("init"),
    cursorContactInboxId: bigintAsString(),
    currentScan: integer().notNull().default(0),
    updatedCount: integer().notNull().default(0),
    avatarCount: integer().notNull().default(0),
    skippedCount: integer().notNull().default(0),
    failedCount: integer().notNull().default(0),
    currentError: text(),
    startedAt: timestamp(timestampConfig),
    finishedAt: timestamp(timestampConfig),
    lastHeartbeatAt: timestamp(timestampConfig),
    cancelRequestedAt: timestamp(timestampConfig),
  },
  (table) => [
    index("MessengerProfileBackfillRun_workspace_idx").on(table.workspaceId),
    index("MessengerProfileBackfillRun_integration_idx").on(
      table.integrationMessengerId,
    ),
    uniqueIndex("MessengerProfileBackfillRun_active_uq")
      .on(table.integrationMessengerId)
      .where(sql`${table.status} IN ('init', 'running')`),
  ],
)
