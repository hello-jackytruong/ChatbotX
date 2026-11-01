ALTER TABLE "CoexistSyncRun" ADD COLUMN IF NOT EXISTS "skippedUnavailableCount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "CoexistSyncRun" ADD COLUMN IF NOT EXISTS "rangeFromAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "CoexistSyncRun" ADD COLUMN IF NOT EXISTS "rangeToAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "CoexistSyncRun" ADD COLUMN IF NOT EXISTS "includeContacts" boolean;--> statement-breakpoint
ALTER TABLE "CoexistSyncRun" ADD COLUMN IF NOT EXISTS "includeMessages" boolean;--> statement-breakpoint
ALTER TABLE "CoexistSyncRun" ADD COLUMN IF NOT EXISTS "cancelRequestedAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "IntegrationMessenger" ADD COLUMN IF NOT EXISTS "lastAutoBackfillAt" timestamp(6) with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "CoexistSyncRun_backfill_active_uq" ON "CoexistSyncRun" ("integrationId") WHERE type = 'backfill' AND status IN ('init', 'running');--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CoexistSyncRun_backfill_due_idx" ON "CoexistSyncRun" ("type","status","createdAt") WHERE type = 'backfill';
