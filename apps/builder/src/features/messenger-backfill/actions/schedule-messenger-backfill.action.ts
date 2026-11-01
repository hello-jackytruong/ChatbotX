"use server"

import { ChatbotXException } from "@chatbotx.io/business/errors"
import { messengerBackfillService } from "@chatbotx.io/business/messenger-backfill"
import {
  buildMessengerBackfillJobId,
  IntegrationJobAction,
  integrationQueue,
} from "@chatbotx.io/worker-config"
import { revalidatePath } from "next/cache"
import { returnValidationErrors } from "next-safe-action"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { assertWorkspaceSuperAdmin } from "@/lib/auth/assert-workspace-super-admin"
import { getCurrentUser } from "@/lib/auth/utils"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  type ScheduleMessengerBackfillRequest,
  scheduleMessengerBackfillRequest,
} from "../schema/action"

export const scheduleMessengerBackfillAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(scheduleMessengerBackfillRequest)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId],
      parsedInput,
    }: {
      bindArgsParsedInputs: WorkspaceIdRequestParams
      parsedInput: ScheduleMessengerBackfillRequest
    }) => {
      const user = await getCurrentUser()
      if (!user) {
        return returnValidationErrors(scheduleMessengerBackfillRequest, {
          _errors: ["Unauthorized"],
        })
      }

      try {
        await assertWorkspaceSuperAdmin(workspaceId)
        const result = await messengerBackfillService.schedule({
          workspaceId,
          requestedByUserId: user.id,
          triggerSource: "manual",
          ...parsedInput,
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
      } catch (error) {
        if (error instanceof ChatbotXException) {
          return returnValidationErrors(scheduleMessengerBackfillRequest, {
            _errors: [error.message],
          })
        }
        throw error
      }
    },
  )
