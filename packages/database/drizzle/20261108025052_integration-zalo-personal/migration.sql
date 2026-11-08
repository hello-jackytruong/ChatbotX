CREATE TABLE "IntegrationZaloPersonal" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"auth" jsonb NOT NULL,
	"encryptedSecret" jsonb NOT NULL,
	"accountId" text NOT NULL,
	"bridgeUrl" text NOT NULL,
	"keyId" text NOT NULL,
	"name" text NOT NULL,
	"workspaceId" bigint NOT NULL,
	"inboxId" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "IntegrationZaloPersonal_workspaceId_idx" ON "IntegrationZaloPersonal" ("workspaceId");--> statement-breakpoint
CREATE UNIQUE INDEX "IntegrationZaloPersonal_inboxId_key" ON "IntegrationZaloPersonal" ("inboxId");--> statement-breakpoint
CREATE UNIQUE INDEX "IntegrationZaloPersonal_workspaceId_accountId_key" ON "IntegrationZaloPersonal" ("workspaceId","accountId");--> statement-breakpoint
ALTER TABLE "IntegrationZaloPersonal" ADD CONSTRAINT "IntegrationZaloPersonal_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "IntegrationZaloPersonal" ADD CONSTRAINT "IntegrationZaloPersonal_inboxId_Inbox_id_fkey" FOREIGN KEY ("inboxId") REFERENCES "Inbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;