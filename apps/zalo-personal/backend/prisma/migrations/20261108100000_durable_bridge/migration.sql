-- Expand-only durable bridge schema. This migration is generated for review and is not applied automatically.
CREATE TABLE "bridge_clients" (
  "id" TEXT NOT NULL,
  "kid" TEXT NOT NULL,
  "secret_ciphertext" TEXT NOT NULL,
  "previous_secret_ciphertext" TEXT,
  "previous_secret_expires_at" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "rotated_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bridge_clients_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bridge_auth_nonces" (
  "kid" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bridge_auth_nonces_pkey" PRIMARY KEY ("kid", "nonce")
);

CREATE TABLE "bridge_account_mappings" (
  "id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "chatbotx_workspace_id" TEXT NOT NULL,
  "chatbotx_inbox_id" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bridge_account_mappings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bridge_dead_letters" (
  "id" TEXT NOT NULL,
  "client_id" TEXT,
  "account_id" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "event_id" TEXT,
  "command_id" TEXT,
  "error_code" TEXT NOT NULL,
  "payload_digest" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bridge_dead_letters_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bridge_clients_kid_key" ON "bridge_clients"("kid");
CREATE INDEX "bridge_clients_active_revoked_at_idx" ON "bridge_clients"("active", "revoked_at");
CREATE INDEX "bridge_auth_nonces_expires_at_idx" ON "bridge_auth_nonces"("expires_at");
CREATE UNIQUE INDEX "bridge_account_mappings_client_id_account_id_key" ON "bridge_account_mappings"("client_id", "account_id");
CREATE UNIQUE INDEX "bridge_account_mappings_chatbotx_workspace_id_chatbotx_inbox_id_key" ON "bridge_account_mappings"("chatbotx_workspace_id", "chatbotx_inbox_id");
CREATE INDEX "bridge_account_mappings_account_id_idx" ON "bridge_account_mappings"("account_id");
CREATE INDEX "bridge_dead_letters_client_id_idx" ON "bridge_dead_letters"("client_id");
CREATE INDEX "bridge_dead_letters_account_id_resolved_at_next_attempt_at_idx" ON "bridge_dead_letters"("account_id", "resolved_at", "next_attempt_at");

ALTER TABLE "bridge_auth_nonces" ADD CONSTRAINT "bridge_auth_nonces_kid_fkey"
  FOREIGN KEY ("kid") REFERENCES "bridge_clients"("kid") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bridge_account_mappings" ADD CONSTRAINT "bridge_account_mappings_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "bridge_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bridge_account_mappings" ADD CONSTRAINT "bridge_account_mappings_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "zalo_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bridge_dead_letters" ADD CONSTRAINT "bridge_dead_letters_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "bridge_clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bridge_dead_letters" ADD CONSTRAINT "bridge_dead_letters_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "zalo_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
