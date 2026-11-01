"use server"

import { messengerProfileBackfillService } from "@chatbotx.io/business/messenger-profile-backfill"
import { zodBigintAsString } from "@chatbotx.io/utils"
import {
  buildMessengerProfileBackfillJobId,
  LowJobAction,
  lowQueue,
} from "@chatbotx.io/worker-config"
import { revalidatePath } from "next/cache"
import { assertCanManagePancakeCredential } from "@/features/integration-messenger/pancake-credential/lib/assert-can-manage"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  messengerProfileBackfillRunRequest,
  scheduleMessengerProfileBackfillRequest,
} from "../schema/action"

const enqueue = async (workspaceId: string, runId: string) => {
  try {
    await lowQueue.add(
      LowJobAction.messengerProfileBackfill,
      {
        type: LowJobAction.messengerProfileBackfill,
        data: { workspaceId, runId },
      },
      {
        jobId: buildMessengerProfileBackfillJobId(runId),
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { count: 100 },
      },
    )
  } catch (error) {
    await messengerProfileBackfillService.finish({
      workspaceId,
      runId,
      status: "failed",
      currentError: "Could not enqueue profile backfill",
    })
    throw error
  }
}

const refreshPath = (workspaceId: string) =>
  revalidatePath(`/space/${workspaceId}/settings/backfill`)

export const scheduleMessengerProfileBackfillAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString()])
  .inputSchema(scheduleMessengerProfileBackfillRequest)
  .action(async ({ bindArgsParsedInputs: [workspaceId], parsedInput, ctx }) => {
    await assertCanManagePancakeCredential(ctx)
    const result = await messengerProfileBackfillService.schedule({
      workspaceId,
      requestedByUserId: ctx.user.id,
      ...parsedInput,
    })
    await enqueue(workspaceId, result.runId)
    refreshPath(workspaceId)
    return result
  })

export const cancelMessengerProfileBackfillAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString()])
  .inputSchema(messengerProfileBackfillRunRequest)
  .action(async ({ bindArgsParsedInputs: [workspaceId], parsedInput, ctx }) => {
    await assertCanManagePancakeCredential(ctx)
    await messengerProfileBackfillService.requestCancel({
      workspaceId,
      runId: parsedInput.runId,
    })
    refreshPath(workspaceId)
    return { success: true }
  })

export const retryMessengerProfileBackfillAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString()])
  .inputSchema(messengerProfileBackfillRunRequest)
  .action(async ({ bindArgsParsedInputs: [workspaceId], parsedInput, ctx }) => {
    await assertCanManagePancakeCredential(ctx)
    const result = await messengerProfileBackfillService.retry({
      workspaceId,
      runId: parsedInput.runId,
      requestedByUserId: ctx.user.id,
    })
    await enqueue(workspaceId, result.runId)
    refreshPath(workspaceId)
    return result
  })
