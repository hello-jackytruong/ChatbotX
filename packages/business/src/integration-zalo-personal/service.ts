import { db } from "@chatbotx.io/database/client"
import { connectionRepository } from "@chatbotx.io/database/repositories"
import { encryptUtils } from "@chatbotx.io/encryption"
import { z } from "zod"
import { BaseService } from "../base.service"
import {
  type IntegrationZaloPersonalResource,
  type ZaloPersonalRuntimeAuth,
  zaloPersonalRuntimeAuthSchema,
} from "./schema"

const secretSchema = z.object({
  v: z.literal(1),
  kid: z.string().optional(),
  iv: z.string().length(24),
  text: z.string().min(1),
  tag: z.string().length(32),
  aad: z.string().optional(),
})

const secretAad = (workspaceId: string, accountId: string): string =>
  `zalo-personal:${workspaceId}:${accountId}`

async function decryptRuntimeAuth(row: {
  accountId: string
  auth: unknown
  bridgeUrl: string
  encryptedSecret: unknown
  keyId: string
  workspaceId: string
}): Promise<ZaloPersonalRuntimeAuth> {
  const secret = await encryptUtils.decryptObject(
    secretSchema.parse(row.encryptedSecret),
    z.object({ secret: z.string().min(1) }),
    secretAad(row.workspaceId, row.accountId),
  )
  return zaloPersonalRuntimeAuthSchema.parse({
    ...(row.auth as Record<string, unknown>),
    accountId: row.accountId,
    bridgeUrl: row.bridgeUrl,
    keyId: row.keyId,
    secret: secret.secret,
  })
}

async function toResource(row: {
  id: string
  inboxId: string
  workspaceId: string
  accountId: string
  bridgeUrl: string
  keyId: string
  name: string
}): Promise<IntegrationZaloPersonalResource> {
  const connection = await connectionRepository.findByInboxId({
    inboxId: row.inboxId,
  })
  return {
    ...row,
    status: connection?.status ?? "disconnected",
  }
}

class IntegrationZaloPersonalService extends BaseService {
  async listByWorkspaceId(
    workspaceId: string,
  ): Promise<IntegrationZaloPersonalResource[]> {
    const rows = await db.query.integrationZaloPersonalModel.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      columns: {
        id: true,
        inboxId: true,
        workspaceId: true,
        accountId: true,
        bridgeUrl: true,
        keyId: true,
        name: true,
      },
    })
    return await Promise.all(rows.map(toResource))
  }

  async findByIdForWorkspace(input: { id: string; workspaceId: string }) {
    const row = await db.query.integrationZaloPersonalModel.findFirst({
      where: input,
      columns: {
        id: true,
        inboxId: true,
        workspaceId: true,
        accountId: true,
        bridgeUrl: true,
        keyId: true,
        name: true,
      },
    })
    return row ? await toResource(row) : null
  }

  async loadRuntimeAuthByInbox(input: {
    inboxId: string
    workspaceId: string
  }): Promise<ZaloPersonalRuntimeAuth | null> {
    const row = await db.query.integrationZaloPersonalModel.findFirst({
      where: input,
    })
    return row ? await decryptRuntimeAuth(row) : null
  }

  async loadRuntimeRowByInbox(input: { inboxId: string }) {
    const row = await db.query.integrationZaloPersonalModel.findFirst({
      where: input,
    })
    return row ? { ...row, auth: await decryptRuntimeAuth(row) } : null
  }

  async loadRuntimeByAccountIdentifier(accountId: string) {
    const rows = await db.query.integrationZaloPersonalModel.findMany({
      where: { accountId },
      limit: 2,
    })
    if (rows.length !== 1) {
      return null
    }
    const row = rows[0]
    return { ...row, auth: await decryptRuntimeAuth(row) }
  }

  async loadRuntimeByAccount(input: {
    accountId: string
    workspaceId: string
  }) {
    const row = await db.query.integrationZaloPersonalModel.findFirst({
      where: input,
    })
    if (!row) {
      return null
    }
    return { ...row, auth: await decryptRuntimeAuth(row) }
  }

  async listActiveRuntimeRows(limit = 1000) {
    const rows = await db.query.integrationZaloPersonalModel.findMany({
      orderBy: { id: "asc" },
      limit,
    })
    const active = await Promise.all(
      rows.map(async (row) => {
        const connection = await connectionRepository.findByInboxId({
          inboxId: row.inboxId,
        })
        if (
          !(
            connection?.status === "connected" ||
            connection?.status === "degraded"
          )
        ) {
          return null
        }
        return { ...row, auth: await decryptRuntimeAuth(row) }
      }),
    )
    return active.filter((row) => row !== null)
  }

  encryptSecret(input: {
    accountId: string
    secret: string
    workspaceId: string
  }) {
    return encryptUtils.encryptObject(
      { secret: input.secret },
      secretAad(input.workspaceId, input.accountId),
    )
  }
}

export const integrationZaloPersonalService =
  new IntegrationZaloPersonalService()
