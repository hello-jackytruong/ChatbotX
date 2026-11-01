CREATE TYPE "messengerProfileBackfillPolicy" AS ENUM('pancake', 'meta', 'pancakeThenMeta');--> statement-breakpoint
CREATE TYPE "messengerProfileBackfillStatus" AS ENUM('init', 'running', 'succeeded', 'partial', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "MessengerProfileBackfillRun" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"integrationMessengerId" bigint NOT NULL,
	"requestedByUserId" bigint,
	"policy" "messengerProfileBackfillPolicy" DEFAULT 'pancake'::"messengerProfileBackfillPolicy" NOT NULL,
	"status" "messengerProfileBackfillStatus" DEFAULT 'init'::"messengerProfileBackfillStatus" NOT NULL,
	"cursorContactInboxId" bigint,
	"currentScan" integer DEFAULT 0 NOT NULL,
	"updatedCount" integer DEFAULT 0 NOT NULL,
	"avatarCount" integer DEFAULT 0 NOT NULL,
	"skippedCount" integer DEFAULT 0 NOT NULL,
	"failedCount" integer DEFAULT 0 NOT NULL,
	"currentError" text,
	"startedAt" timestamp(6) with time zone,
	"finishedAt" timestamp(6) with time zone,
	"lastHeartbeatAt" timestamp(6) with time zone,
	"cancelRequestedAt" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE INDEX "MessengerProfileBackfillRun_workspace_idx" ON "MessengerProfileBackfillRun" ("workspaceId");--> statement-breakpoint
CREATE INDEX "MessengerProfileBackfillRun_integration_idx" ON "MessengerProfileBackfillRun" ("integrationMessengerId");--> statement-breakpoint
CREATE UNIQUE INDEX "MessengerProfileBackfillRun_active_uq" ON "MessengerProfileBackfillRun" ("integrationMessengerId") WHERE "status" IN ('init', 'running');--> statement-breakpoint
ALTER TABLE "MessengerProfileBackfillRun" ADD CONSTRAINT "MessengerProfileBackfillRun_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "MessengerProfileBackfillRun" ADD CONSTRAINT "MessengerProfileBackfillRun_mT0OEi4d88M6_fkey" FOREIGN KEY ("integrationMessengerId") REFERENCES "IntegrationMessenger"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "MessengerProfileBackfillRun" ADD CONSTRAINT "MessengerProfileBackfillRun_requestedByUserId_User_id_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;