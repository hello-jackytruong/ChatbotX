import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const integrationZaloPersonalRelations = defineRelationsPart(
  schema,
  (r) => ({
    integrationZaloPersonalModel: {
      workspace: r.one.workspaceModel({
        from: r.integrationZaloPersonalModel.workspaceId,
        to: r.workspaceModel.id,
        optional: false,
      }),
      inbox: r.one.inboxModel({
        from: r.integrationZaloPersonalModel.inboxId,
        to: r.inboxModel.id,
        optional: false,
      }),
    },
  }),
)
