import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';

export type BridgeAccountBindingStatus = 'bound' | 'conflict' | 'not_found';

type BridgeAccountBindingInput = {
  kid: string;
  accountId: string;
  workspaceId: string;
  inboxId: string;
};

export class PrismaBridgeAccountBindingRepository {
  constructor(
    private readonly sql: Pick<typeof prisma, '$queryRaw'> = prisma,
  ) {}

  async bind(input: BridgeAccountBindingInput): Promise<BridgeAccountBindingStatus> {
    const updated = await this.sql.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "bridge_account_mappings" mapping
      SET "chatbotx_inbox_id" = ${input.inboxId},
          "updated_at" = CURRENT_TIMESTAMP
      FROM "bridge_clients" client
      WHERE mapping."client_id" = client."id"
        AND client."kid" = ${input.kid}
        AND mapping."account_id" = ${input.accountId}
        AND mapping."active" = TRUE
        AND mapping."chatbotx_workspace_id" = ${input.workspaceId}
        AND (
          mapping."chatbotx_inbox_id" IS NULL
          OR mapping."chatbotx_inbox_id" = ${input.inboxId}
        )
      RETURNING mapping."id"
    `);
    if (updated.length === 1) return 'bound';

    const existing = await this.sql.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT mapping."id"
      FROM "bridge_account_mappings" mapping
      JOIN "bridge_clients" client ON client."id" = mapping."client_id"
      WHERE client."kid" = ${input.kid}
        AND mapping."account_id" = ${input.accountId}
        AND mapping."active" = TRUE
      LIMIT 1
    `);
    return existing.length === 0 ? 'not_found' : 'conflict';
  }
}
