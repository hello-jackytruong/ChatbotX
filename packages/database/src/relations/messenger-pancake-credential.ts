import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const messengerPancakeCredentialRelations = defineRelationsPart(
  schema,
  (r) => ({
    messengerPancakeCredentialModel: {
      workspace: r.one.workspaceModel({
        from: r.messengerPancakeCredentialModel.workspaceId,
        to: r.workspaceModel.id,
        optional: false,
      }),
      integrationMessenger: r.one.integrationMessengerModel({
        from: r.messengerPancakeCredentialModel.integrationMessengerId,
        to: r.integrationMessengerModel.id,
        optional: false,
      }),
      updatedByUser: r.one.userModel({
        from: r.messengerPancakeCredentialModel.updatedByUserId,
        to: r.userModel.id,
      }),
    },
  }),
)
