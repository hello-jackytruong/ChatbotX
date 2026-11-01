"use server"

import { messengerBackfillService } from "@chatbotx.io/business/messenger-backfill"
import { revalidatePath } from "next/cache"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { assertWorkspaceSuperAdmin } from "@/lib/auth/assert-workspace-super-admin"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  type MessengerBackfillRunRequest,
  messengerBackfillRunRequest,
} from "../schema/action"

export const cancelMessengerBackfillAction = workspaceActionClient
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
      const cancelled = await messengerBackfillService.requestCancel({
        workspaceId,
        runId: parsedInput.runId,
      })
      revalidatePath(`/space/${workspaceId}/settings/backfill`)
      return { cancelled }
    },
  )
