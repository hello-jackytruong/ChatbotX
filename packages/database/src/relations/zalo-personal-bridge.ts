import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const zaloPersonalBridgeRelations = defineRelationsPart(schema, (r) => ({
  zaloPersonalCommandOutboxModel: {
    workspace: r.one.workspaceModel({
      from: r.zaloPersonalCommandOutboxModel.workspaceId,
      to: r.workspaceModel.id,
      optional: false,
    }),
    integration: r.one.integrationZaloPersonalModel({
      from: r.zaloPersonalCommandOutboxModel.integrationId,
      to: r.integrationZaloPersonalModel.id,
      optional: false,
    }),
    inbox: r.one.inboxModel({
      from: r.zaloPersonalCommandOutboxModel.inboxId,
      to: r.inboxModel.id,
      optional: false,
    }),
  },
  zaloPersonalBridgeCheckpointModel: {
    workspace: r.one.workspaceModel({
      from: r.zaloPersonalBridgeCheckpointModel.workspaceId,
      to: r.workspaceModel.id,
      optional: false,
    }),
    integration: r.one.integrationZaloPersonalModel({
      from: r.zaloPersonalBridgeCheckpointModel.integrationId,
      to: r.integrationZaloPersonalModel.id,
      optional: false,
    }),
  },
  zaloPersonalThreadMappingModel: {
    workspace: r.one.workspaceModel({
      from: r.zaloPersonalThreadMappingModel.workspaceId,
      to: r.workspaceModel.id,
      optional: false,
    }),
    inbox: r.one.inboxModel({
      from: r.zaloPersonalThreadMappingModel.inboxId,
      to: r.inboxModel.id,
      optional: false,
    }),
    conversation: r.one.conversationModel({
      from: r.zaloPersonalThreadMappingModel.conversationId,
      to: r.conversationModel.id,
      optional: false,
    }),
  },
  zaloPersonalContactMappingModel: {
    workspace: r.one.workspaceModel({
      from: r.zaloPersonalContactMappingModel.workspaceId,
      to: r.workspaceModel.id,
      optional: false,
    }),
    inbox: r.one.inboxModel({
      from: r.zaloPersonalContactMappingModel.inboxId,
      to: r.inboxModel.id,
      optional: false,
    }),
    contact: r.one.contactModel({
      from: r.zaloPersonalContactMappingModel.contactId,
      to: r.contactModel.id,
      optional: false,
    }),
  },
  zaloPersonalMessageMappingModel: {
    workspace: r.one.workspaceModel({
      from: r.zaloPersonalMessageMappingModel.workspaceId,
      to: r.workspaceModel.id,
      optional: false,
    }),
    inbox: r.one.inboxModel({
      from: r.zaloPersonalMessageMappingModel.inboxId,
      to: r.inboxModel.id,
      optional: false,
    }),
  },
  zaloPersonalBridgeDeadLetterModel: {
    workspace: r.one.workspaceModel({
      from: r.zaloPersonalBridgeDeadLetterModel.workspaceId,
      to: r.workspaceModel.id,
      optional: false,
    }),
    integration: r.one.integrationZaloPersonalModel({
      from: r.zaloPersonalBridgeDeadLetterModel.integrationId,
      to: r.integrationZaloPersonalModel.id,
      optional: false,
    }),
    inbox: r.one.inboxModel({
      from: r.zaloPersonalBridgeDeadLetterModel.inboxId,
      to: r.inboxModel.id,
      optional: false,
    }),
  },
}))
