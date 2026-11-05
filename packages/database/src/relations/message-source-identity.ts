import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const messageSourceIdentityRelations = defineRelationsPart(
  schema,
  (r) => ({
    messageSourceIdentityModel: {
      workspace: r.one.workspaceModel({
        from: r.messageSourceIdentityModel.workspaceId,
        to: r.workspaceModel.id,
      }),
    },
  }),
)
