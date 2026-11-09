ALTER TABLE "bridge_clients"
  ADD COLUMN "provision_org_id" TEXT,
  ADD COLUMN "provision_owner_user_id" TEXT;

ALTER TABLE "bridge_account_mappings"
  ADD COLUMN "chatbotx_connect_session_id" TEXT;

CREATE UNIQUE INDEX "bridge_account_mappings_chatbotx_connect_session_id_key"
  ON "bridge_account_mappings"("chatbotx_connect_session_id");

CREATE INDEX "gateway_event_outbox_created_at_idx"
  ON "gateway_event_outbox"("created_at");
