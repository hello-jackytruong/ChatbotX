"use server"

import { connectionStateService } from "@chatbotx.io/business/connection"
import { connectionService } from "@chatbotx.io/connections"
import { z } from "zod"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import {
  workspaceActionClient,
  workspaceActionClientAllowExpired,
} from "@/lib/safe-action"
import { requireVisibleChannel } from "@/lib/workspace/require-visible-channel"
import { createZaloPersonalConnectionSchema } from "../schema"

export const connectZaloPersonalAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(createZaloPersonalConnectionSchema)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId],
      parsedInput,
    }: {
      bindArgsParsedInputs: WorkspaceIdRequestParams
      parsedInput: z.infer<typeof createZaloPersonalConnectionSchema>
    }) => {
      await requireVisibleChannel(workspaceId, "zalo_personal")
      await connectionService.connectFromCredentials({
        workspaceId,
        provider: "zalo_personal",
        config: parsedInput,
        allowUpdate: true,
      })
    },
  )

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
