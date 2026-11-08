CREATE TYPE "zaloPersonalBridgeDirection" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "zaloPersonalCommandStatus" AS ENUM('pending', 'processing', 'succeeded', 'rejected', 'failed', 'unknown_outcome');--> statement-breakpoint
CREATE TABLE "ZaloPersonalBridgeCheckpoint" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"integrationId" bigint NOT NULL,
	"accountId" text NOT NULL,
	"lastSequence" bigint DEFAULT 0 NOT NULL,
	"lastFenceToken" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ZaloPersonalBridgeDeadLetter" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"integrationId" bigint NOT NULL,
	"inboxId" bigint NOT NULL,
	"accountId" text NOT NULL,
	"direction" "zaloPersonalBridgeDirection" NOT NULL,
	"eventId" text,
	"commandId" text,
	"errorCode" text NOT NULL,
	"payloadDigest" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"nextAttemptAt" timestamp(6) with time zone,
	"resolvedAt" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE TABLE "ZaloPersonalCommandOutbox" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"integrationId" bigint NOT NULL,
	"inboxId" bigint NOT NULL,
	"messageId" bigint NOT NULL,
	"accountId" text NOT NULL,
	"commandId" text NOT NULL,
	"idempotencyKey" text NOT NULL,
	"payloadHash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "zaloPersonalCommandStatus" DEFAULT 'pending'::"zaloPersonalCommandStatus" NOT NULL,
	"providerMessageId" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"leaseOwner" text,
	"leaseUntil" timestamp(6) with time zone,
	"nextAttemptAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"lastError" text
);
--> statement-breakpoint
CREATE TABLE "ZaloPersonalContactMapping" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"inboxId" bigint NOT NULL,
	"accountId" text NOT NULL,
	"providerContactId" text NOT NULL,
	"contactId" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ZaloPersonalMessageMapping" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"inboxId" bigint NOT NULL,
	"accountId" text NOT NULL,
	"providerMessageId" text NOT NULL,
	"providerClientMessageId" text,
	"messageId" bigint NOT NULL,
	"direction" "zaloPersonalBridgeDirection" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ZaloPersonalThreadMapping" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"inboxId" bigint NOT NULL,
	"accountId" text NOT NULL,
	"providerThreadId" text NOT NULL,
	"conversationId" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ZaloPersonalBridgeCheckpoint_workspaceId_idx" ON "ZaloPersonalBridgeCheckpoint" ("workspaceId");--> statement-breakpoint
CREATE INDEX "ZaloPersonalBridgeCheckpoint_integrationId_idx" ON "ZaloPersonalBridgeCheckpoint" ("integrationId");--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloPersonalBridgeCheckpoint_integrationId_accountId_key" ON "ZaloPersonalBridgeCheckpoint" ("integrationId","accountId");--> statement-breakpoint
CREATE INDEX "ZaloPersonalBridgeDeadLetter_workspaceId_idx" ON "ZaloPersonalBridgeDeadLetter" ("workspaceId");--> statement-breakpoint
CREATE INDEX "ZaloPersonalBridgeDeadLetter_integrationId_idx" ON "ZaloPersonalBridgeDeadLetter" ("integrationId");--> statement-breakpoint
CREATE INDEX "ZaloPersonalBridgeDeadLetter_inboxId_idx" ON "ZaloPersonalBridgeDeadLetter" ("inboxId");--> statement-breakpoint
CREATE INDEX "ZaloPersonalBridgeDeadLetter_retry_idx" ON "ZaloPersonalBridgeDeadLetter" ("resolvedAt","nextAttemptAt");--> statement-breakpoint
CREATE INDEX "ZaloPersonalCommandOutbox_workspaceId_idx" ON "ZaloPersonalCommandOutbox" ("workspaceId");--> statement-breakpoint
CREATE INDEX "ZaloPersonalCommandOutbox_integrationId_idx" ON "ZaloPersonalCommandOutbox" ("integrationId");--> statement-breakpoint
CREATE INDEX "ZaloPersonalCommandOutbox_inboxId_idx" ON "ZaloPersonalCommandOutbox" ("inboxId");--> statement-breakpoint
CREATE INDEX "ZaloPersonalCommandOutbox_status_nextAttemptAt_idx" ON "ZaloPersonalCommandOutbox" ("status","nextAttemptAt");--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloPersonalCommandOutbox_commandId_key" ON "ZaloPersonalCommandOutbox" ("commandId");--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloPersonalCommandOutbox_workspaceId_messageId_key" ON "ZaloPersonalCommandOutbox" ("workspaceId","messageId");--> statement-breakpoint
CREATE INDEX "ZaloPersonalContactMapping_workspaceId_idx" ON "ZaloPersonalContactMapping" ("workspaceId");--> statement-breakpoint
CREATE INDEX "ZaloPersonalContactMapping_inboxId_idx" ON "ZaloPersonalContactMapping" ("inboxId");--> statement-breakpoint
CREATE INDEX "ZaloPersonalContactMapping_contactId_idx" ON "ZaloPersonalContactMapping" ("contactId");--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloPersonalContactMapping_scope_provider_key" ON "ZaloPersonalContactMapping" ("workspaceId","inboxId","accountId","providerContactId");--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloPersonalContactMapping_scope_contact_key" ON "ZaloPersonalContactMapping" ("workspaceId","inboxId","accountId","contactId");--> statement-breakpoint
CREATE INDEX "ZaloPersonalMessageMapping_workspaceId_idx" ON "ZaloPersonalMessageMapping" ("workspaceId");--> statement-breakpoint
CREATE INDEX "ZaloPersonalMessageMapping_inboxId_idx" ON "ZaloPersonalMessageMapping" ("inboxId");--> statement-breakpoint
CREATE INDEX "ZaloPersonalMessageMapping_messageId_idx" ON "ZaloPersonalMessageMapping" ("messageId");--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloPersonalMessageMapping_scope_provider_key" ON "ZaloPersonalMessageMapping" ("workspaceId","inboxId","accountId","providerMessageId");--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloPersonalMessageMapping_scope_message_key" ON "ZaloPersonalMessageMapping" ("workspaceId","inboxId","accountId","messageId");--> statement-breakpoint
CREATE INDEX "ZaloPersonalThreadMapping_workspaceId_idx" ON "ZaloPersonalThreadMapping" ("workspaceId");--> statement-breakpoint
CREATE INDEX "ZaloPersonalThreadMapping_inboxId_idx" ON "ZaloPersonalThreadMapping" ("inboxId");--> statement-breakpoint
CREATE INDEX "ZaloPersonalThreadMapping_conversationId_idx" ON "ZaloPersonalThreadMapping" ("conversationId");--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloPersonalThreadMapping_scope_provider_key" ON "ZaloPersonalThreadMapping" ("workspaceId","inboxId","accountId","providerThreadId");--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloPersonalThreadMapping_scope_conversation_key" ON "ZaloPersonalThreadMapping" ("workspaceId","inboxId","accountId","conversationId");--> statement-breakpoint
ALTER TABLE "ZaloPersonalBridgeCheckpoint" ADD CONSTRAINT "ZaloPersonalBridgeCheckpoint_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloPersonalBridgeDeadLetter" ADD CONSTRAINT "ZaloPersonalBridgeDeadLetter_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloPersonalBridgeDeadLetter" ADD CONSTRAINT "ZaloPersonalBridgeDeadLetter_inboxId_Inbox_id_fkey" FOREIGN KEY ("inboxId") REFERENCES "Inbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloPersonalCommandOutbox" ADD CONSTRAINT "ZaloPersonalCommandOutbox_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloPersonalCommandOutbox" ADD CONSTRAINT "ZaloPersonalCommandOutbox_inboxId_Inbox_id_fkey" FOREIGN KEY ("inboxId") REFERENCES "Inbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloPersonalContactMapping" ADD CONSTRAINT "ZaloPersonalContactMapping_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloPersonalContactMapping" ADD CONSTRAINT "ZaloPersonalContactMapping_inboxId_Inbox_id_fkey" FOREIGN KEY ("inboxId") REFERENCES "Inbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloPersonalContactMapping" ADD CONSTRAINT "ZaloPersonalContactMapping_contactId_Contact_id_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloPersonalMessageMapping" ADD CONSTRAINT "ZaloPersonalMessageMapping_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloPersonalMessageMapping" ADD CONSTRAINT "ZaloPersonalMessageMapping_inboxId_Inbox_id_fkey" FOREIGN KEY ("inboxId") REFERENCES "Inbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloPersonalThreadMapping" ADD CONSTRAINT "ZaloPersonalThreadMapping_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloPersonalThreadMapping" ADD CONSTRAINT "ZaloPersonalThreadMapping_inboxId_Inbox_id_fkey" FOREIGN KEY ("inboxId") REFERENCES "Inbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloPersonalThreadMapping" ADD CONSTRAINT "ZaloPersonalThreadMapping_conversationId_Conversation_id_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
