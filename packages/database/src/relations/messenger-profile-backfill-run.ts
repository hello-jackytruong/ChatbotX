import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const messengerProfileBackfillRunRelations = defineRelationsPart(
  schema,
  (r) => ({
    messengerProfileBackfillRunModel: {
      workspace: r.one.workspaceModel({
        from: r.messengerProfileBackfillRunModel.workspaceId,
        to: r.workspaceModel.id,
        optional: false,
      }),
      integrationMessenger: r.one.integrationMessengerModel({
        from: r.messengerProfileBackfillRunModel.integrationMessengerId,
        to: r.integrationMessengerModel.id,
        optional: false,
      }),
      requestedByUser: r.one.userModel({
        from: r.messengerProfileBackfillRunModel.requestedByUserId,
        to: r.userModel.id,
      }),
    },
  }),
)
