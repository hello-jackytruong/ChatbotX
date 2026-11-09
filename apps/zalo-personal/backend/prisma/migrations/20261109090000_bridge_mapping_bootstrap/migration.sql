DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "bridge_account_mappings"
    GROUP BY "account_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'bridge_account_mappings contains duplicate account_id values';
  END IF;
END $$;

ALTER TABLE "bridge_account_mappings"
  ALTER COLUMN "chatbotx_inbox_id" DROP NOT NULL;

CREATE UNIQUE INDEX "bridge_account_mappings_account_id_key"
  ON "bridge_account_mappings"("account_id");
