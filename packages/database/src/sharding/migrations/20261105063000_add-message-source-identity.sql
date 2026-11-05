CREATE TABLE IF NOT EXISTS "MessageSourceIdentity" (
  "workspaceId" bigint NOT NULL,
  "contactInboxId" bigint NOT NULL,
  "sourceId" text NOT NULL,
  "messageId" bigint NOT NULL,
  "messageCreatedAt" timestamp(6) with time zone NOT NULL,
  "createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "MessageSourceIdentity_pkey"
    PRIMARY KEY ("workspaceId", "contactInboxId", "sourceId")
);

CREATE INDEX IF NOT EXISTS "MessageSourceIdentity_message_idx"
  ON "MessageSourceIdentity" ("workspaceId", "messageId", "messageCreatedAt");
