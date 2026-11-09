ALTER TABLE "ConnectSession" ADD COLUMN "providerReference" text;--> statement-breakpoint
ALTER TABLE "ConnectSession" ADD COLUMN "providerCursor" text;--> statement-breakpoint
CREATE INDEX "ConnectSession_provider_providerReference_idx" ON "ConnectSession" ("provider","providerReference") WHERE "providerReference" IS NOT NULL;