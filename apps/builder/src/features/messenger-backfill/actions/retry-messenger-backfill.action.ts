"use server"

import { messengerBackfillService } from "@chatbotx.io/business/messenger-backfill"
import {
  buildMessengerBackfillJobId,
  IntegrationJobAction,
  integrationQueue,
} from "@chatbotx.io/worker-config"
import { revalidatePath } from "next/cache"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { assertWorkspaceSuperAdmin } from "@/lib/auth/assert-workspace-super-admin"
import { getCurrentUser } from "@/lib/auth/utils"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  type MessengerBackfillRunRequest,
  messengerBackfillRunRequest,
} from "../schema/action"

export const retryMessengerBackfillAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(messengerBackfillRunRequest)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId],
      parsedInput,
    }: {
      bindArgsParsedInputs: WorkspaceIdRequestParams
      parsedInput: MessengerBackfillRunRequest
    }) => {
      await assertWorkspaceSuperAdmin(workspaceId)
      const user = await getCurrentUser()
      const result = await messengerBackfillService.retry({
        workspaceId,
        runId: parsedInput.runId,
        requestedByUserId: user?.id ?? null,
      })
      await integrationQueue
        .add(
          IntegrationJobAction.messengerBackfill,
          {
            type: IntegrationJobAction.messengerBackfill,
            data: { runId: result.runId, workspaceId },
          },
          {
            jobId: buildMessengerBackfillJobId({
              runId: result.runId,
              attempts: 0,
            }),
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: { count: 100 },
          },
        )
        .catch(() => undefined)
      revalidatePath(`/space/${workspaceId}/settings/backfill`)
      return result
    },
  )
