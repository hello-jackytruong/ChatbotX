CREATE TABLE "MessengerPancakeCredential" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"integrationMessengerId" bigint NOT NULL,
	"encryptedToken" jsonb NOT NULL,
	"verifiedAt" timestamp(6) with time zone NOT NULL,
	"updatedByUserId" bigint
);
--> statement-breakpoint
CREATE INDEX "MessengerPancakeCredential_workspaceId_idx" ON "MessengerPancakeCredential" ("workspaceId");--> statement-breakpoint
CREATE UNIQUE INDEX "MessengerPancakeCredential_integrationMessengerId_key" ON "MessengerPancakeCredential" ("integrationMessengerId");--> statement-breakpoint
CREATE INDEX "MessengerPancakeCredential_updatedByUserId_idx" ON "MessengerPancakeCredential" ("updatedByUserId") WHERE "updatedByUserId" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "MessengerPancakeCredential" ADD CONSTRAINT "MessengerPancakeCredential_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "MessengerPancakeCredential" ADD CONSTRAINT "MessengerPancakeCredential_KBdgiNAEJ2Vs_fkey" FOREIGN KEY ("integrationMessengerId") REFERENCES "IntegrationMessenger"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "MessengerPancakeCredential" ADD CONSTRAINT "MessengerPancakeCredential_updatedByUserId_User_id_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;