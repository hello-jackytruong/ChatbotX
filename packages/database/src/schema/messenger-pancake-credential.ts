import type { EncryptedData } from "@chatbotx.io/encryption"
import { sql } from "drizzle-orm"
import {
  index,
  jsonb,
  pgTable,
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

/**
 * A write-only Pancake Page credential for one Messenger integration.
 * Plaintext is never persisted; the business service decrypts the AES-GCM
 * envelope only inside a backend callback bound to workspace + integration.
 */
export const messengerPancakeCredentialModel = pgTable(
  "MessengerPancakeCredential",
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
    encryptedToken: jsonb().$type<EncryptedData>().notNull(),
    verifiedAt: timestamp(timestampConfig).notNull(),
    updatedByUserId: bigintAsString().references(() => userModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (table) => [
    index("MessengerPancakeCredential_workspaceId_idx").on(table.workspaceId),
    uniqueIndex("MessengerPancakeCredential_integrationMessengerId_key").on(
      table.integrationMessengerId,
    ),
    index("MessengerPancakeCredential_updatedByUserId_idx")
      .on(table.updatedByUserId)
      .where(sql`${table.updatedByUserId} IS NOT NULL`),
  ],
)
