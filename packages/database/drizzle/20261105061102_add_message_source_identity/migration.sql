CREATE TABLE "MessageSourceIdentity" (
	"workspaceId" bigint,
	"contactInboxId" bigint,
	"sourceId" text,
	"messageId" bigint NOT NULL,
	"messageCreatedAt" timestamp(6) with time zone NOT NULL,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "MessageSourceIdentity_pkey" PRIMARY KEY("workspaceId","contactInboxId","sourceId")
);
--> statement-breakpoint
CREATE INDEX "MessageSourceIdentity_message_idx" ON "MessageSourceIdentity" ("workspaceId","messageId","messageCreatedAt");