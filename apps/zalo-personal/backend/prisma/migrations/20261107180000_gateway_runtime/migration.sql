-- Expand-only gateway runtime schema. This migration is generated for review and is not applied automatically.
ALTER TABLE "zalo_accounts"
  ADD COLUMN "session_ciphertext" TEXT,
  ADD COLUMN "proxy_ciphertext" TEXT;

CREATE TABLE "gateway_account_leases" (
  "account_id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "fence_token" BIGINT NOT NULL DEFAULT 1,
  "lease_until" TIMESTAMP(3) NOT NULL,
  "heartbeat_at" TIMESTAMP(3) NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gateway_account_leases_pkey" PRIMARY KEY ("account_id")
);

CREATE TABLE "gateway_commands" (
  "command_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "result" JSONB,
  "error" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_owner" TEXT,
  "lease_until" TIMESTAMP(3),
  "fence_token" BIGINT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gateway_commands_pkey" PRIMARY KEY ("command_id")
);

CREATE TABLE "gateway_event_outbox" (
  "event_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "account_sequence" BIGINT NOT NULL,
  "fence_token" BIGINT NOT NULL,
  "kind" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "provider_event_id" TEXT,
  "payload" JSONB NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gateway_event_outbox_pkey" PRIMARY KEY ("event_id")
);

CREATE TABLE "gateway_consumer_checkpoints" (
  "consumer_name" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "last_sequence" BIGINT NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gateway_consumer_checkpoints_pkey" PRIMARY KEY ("consumer_name", "account_id")
);

CREATE INDEX "gateway_account_leases_lease_until_idx" ON "gateway_account_leases"("lease_until");
CREATE UNIQUE INDEX "gateway_commands_account_id_idempotency_key_key" ON "gateway_commands"("account_id", "idempotency_key");
CREATE INDEX "gateway_commands_status_available_at_created_at_idx" ON "gateway_commands"("status", "available_at", "created_at");
CREATE INDEX "gateway_commands_lease_until_idx" ON "gateway_commands"("lease_until");
CREATE UNIQUE INDEX "gateway_event_outbox_account_id_account_sequence_key" ON "gateway_event_outbox"("account_id", "account_sequence");
CREATE UNIQUE INDEX "gateway_event_outbox_account_id_provider_event_id_key" ON "gateway_event_outbox"("account_id", "provider_event_id");
CREATE INDEX "gateway_event_outbox_account_id_created_at_idx" ON "gateway_event_outbox"("account_id", "created_at");

ALTER TABLE "gateway_account_leases" ADD CONSTRAINT "gateway_account_leases_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "zalo_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gateway_commands" ADD CONSTRAINT "gateway_commands_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "zalo_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gateway_event_outbox" ADD CONSTRAINT "gateway_event_outbox_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "zalo_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gateway_consumer_checkpoints" ADD CONSTRAINT "gateway_consumer_checkpoints_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "zalo_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
