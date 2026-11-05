import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core"
import { bigintAsString, timestampConfig } from "../../../partials/shared"

export const messageSourceIdentityModel = pgTable(
  "MessageSourceIdentity",
  {
    workspaceId: bigintAsString().notNull(),
    contactInboxId: bigintAsString().notNull(),
    sourceId: text().notNull(),
    messageId: bigintAsString().notNull(),
    messageCreatedAt: timestamp(timestampConfig).notNull(),
    createdAt: timestamp(timestampConfig).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "MessageSourceIdentity_pkey",
      columns: [table.workspaceId, table.contactInboxId, table.sourceId],
    }),
    index("MessageSourceIdentity_message_idx").on(
      table.workspaceId,
      table.messageId,
      table.messageCreatedAt,
    ),
  ],
)
