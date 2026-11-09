"use server"

import { connectionStateService } from "@chatbotx.io/business/connection"
import { connectionService } from "@chatbotx.io/connections"
import { cancelConnectSession } from "@chatbotx.io/connections/zalo-personal-qr"
import { z } from "zod"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import {
  startConnect,
  startReconnect,
} from "@/features/connections/lib/connect-flow"
import { resolvePlatformOwnerId } from "@/lib/platform-credential-owner"
import {
  workspaceActionClient,
  workspaceActionClientAllowExpired,
} from "@/lib/safe-action"

export const connectZaloPersonalAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(async ({ bindArgsParsedInputs: [workspaceId], ctx }) => {
    const result = await startConnect({
      workspaceId,
      provider: "zalo_personal",
      config: undefined,
      redirectUrl: undefined,
      ownerId: await resolvePlatformOwnerId({
        userId: ctx.user.id,
        workspaceId,
      }),
      actor: { actorUserId: ctx.user.id },
    })
    if (!result.session) {
      throw new Error("Zalo Personal QR session was not created")
    }
    return { sessionId: result.session.id }
  })

export const cancelZaloPersonalConnectAction = workspaceActionClientAllowExpired
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(z.object({ id: z.string().min(1) }))
  .action(async ({ bindArgsParsedInputs: [workspaceId], parsedInput, ctx }) => {
    await cancelConnectSession({
      id: parsedInput.id,
      workspaceId,
      actorUserId: ctx.user.id,
    })
  })

export const reconnectZaloPersonalAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(z.object({ accountId: z.string().min(1) }))
  .action(async ({ bindArgsParsedInputs: [workspaceId], parsedInput, ctx }) => {
    const connection = await connectionStateService.findByProviderSourceId({
      workspaceId,
      provider: "zalo_personal",
      sourceId: parsedInput.accountId,
    })
    if (!connection) {
      throw new Error("Zalo Personal connection was not found")
    }
    const result = await startReconnect({
      connection,
      workspaceId,
      redirectUrl: undefined,
      ownerId: await resolvePlatformOwnerId({
        userId: ctx.user.id,
        workspaceId,
      }),
      actor: { actorUserId: ctx.user.id },
    })
    return { sessionId: result.session.id }
  })

export const disconnectZaloPersonalAction = workspaceActionClientAllowExpired
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(z.object({ accountId: z.string().min(1) }))
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId],
      parsedInput,
    }: {
      bindArgsParsedInputs: WorkspaceIdRequestParams
      parsedInput: { accountId: string }
    }) => {
      const connection = await connectionStateService.findByProviderSourceId({
        workspaceId,
        provider: "zalo_personal",
        sourceId: parsedInput.accountId,
      })
      if (connection) {
        await connectionService.disconnect({
          connectionId: connection.id,
          workspaceId,
        })
      }
    },
  )
