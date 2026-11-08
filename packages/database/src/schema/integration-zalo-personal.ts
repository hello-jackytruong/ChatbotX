import { index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { inboxModel } from "./inbox"
import { workspaceModel } from "./workspace"

type EncryptedSecret = {
  v: 1
  kid?: string
  iv: string
  text: string
  tag: string
  aad?: string
}

export const integrationZaloPersonalModel = pgTable(
  "IntegrationZaloPersonal",
  {
    ...sharedColumns,
    auth: jsonb()
      .$type<{
        authType: "custom"
        accountId: string
        bridgeUrl: string
        keyId: string
      }>()
      .notNull(),
    encryptedSecret: jsonb().$type<EncryptedSecret>().notNull(),
    accountId: text().notNull(),
    bridgeUrl: text().notNull(),
    keyId: text().notNull(),
    name: text().notNull(),
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
  },
  (table) => [
    index("IntegrationZaloPersonal_workspaceId_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
    ),
    uniqueIndex("IntegrationZaloPersonal_inboxId_key").using(
      "btree",
      table.inboxId.asc().nullsLast(),
    ),
    uniqueIndex("IntegrationZaloPersonal_accountId_key").using(
      "btree",
      table.accountId.asc().nullsLast(),
    ),
    uniqueIndex("IntegrationZaloPersonal_workspaceId_accountId_key").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.accountId.asc().nullsLast(),
    ),
  ],
)
