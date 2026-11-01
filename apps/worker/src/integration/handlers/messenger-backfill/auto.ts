import {
  messengerBackfillService,
  messengerIntegrationService,
} from "@chatbotx.io/business"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { listConversations } from "@chatbotx.io/integration-messenger/apis/sync"
import { distributedLock } from "@chatbotx.io/redis"
import {
  buildMessengerBackfillJobId,
  IntegrationJobAction,
  type IntegrationJobMessengerAutoBackfill,
  integrationQueue,
} from "@chatbotx.io/worker-config"
import { env } from "../../../env"
import { logger } from "../../../lib/logger"
import {
  messengerAuthSchema,
  withInlineRetry,
} from "../coexist/messenger-helpers"
import { classifyMessengerBackfillError } from "./error-policy"

const FIVE_MINUTES_MS = 5 * 60 * 1000
const LOCK_SECONDS = 5 * 60
const LOCK_WAIT_SECONDS = 1
const GLOBAL_LOCK_KEY = "messenger-backfill:global"

export const computeAutoBackfillRange = (input: {
  now: Date
  lastAutoBackfillAt: Date | null
  windowMinutes: number
}): { fromAt: Date; toAt: Date } => {
  const minimumFrom = new Date(
    input.now.getTime() - input.windowMinutes * 60 * 1000,
  )
  const checkpointFrom = input.lastAutoBackfillAt
    ? new Date(input.lastAutoBackfillAt.getTime() - FIVE_MINUTES_MS)
    : minimumFrom
  return {
    fromAt: checkpointFrom < minimumFrom ? checkpointFrom : minimumFrom,
    toAt: input.now,
  }
}

export const runMessengerAutoBackfill = (
  data: IntegrationJobMessengerAutoBackfill["data"],
): Promise<void> =>
  distributedLock.runExclusive({
    key: GLOBAL_LOCK_KEY,
    timeoutInSeconds: LOCK_SECONDS,
    retryTimeoutInSeconds: LOCK_WAIT_SECONDS,
    fn: () =>
      distributedLock.runExclusive({
        key: `messenger-backfill:integration:${data.integrationId}`,
        timeoutInSeconds: LOCK_SECONDS,
        retryTimeoutInSeconds: LOCK_WAIT_SECONDS,
        fn: () => probeAndSchedule(data),
      }),
  })

const probeAndSchedule = async (
  data: IntegrationJobMessengerAutoBackfill["data"],
): Promise<void> => {
  const integration = await messengerIntegrationService.findByIdForWorkspace({
    id: data.integrationId,
    workspaceId: data.workspaceId,
  })
  if (!integration) {
    return
  }
  const auth = messengerAuthSchema.safeParse(integration.auth)
  if (!auth.success) {
    logger.warn(
      { integrationId: data.integrationId },
      "[messenger-auto-backfill] credentials invalid; reconnect required",
    )
    return
  }

  const range = computeAutoBackfillRange({
    now: new Date(),
    lastAutoBackfillAt: integration.lastAutoBackfillAt,
    windowMinutes: env.MESSENGER_AUTO_BACKFILL_WINDOW_MINUTES,
  })

  let hasActivity = false
  try {
    const page = await withInlineRetry(() =>
      listConversations({
        pageId: integration.pageId,
        accessToken: auth.data.tokens.accessToken,
        version: auth.data.metadata?.version,
      }),
    )
    hasActivity = page.data.some((conversation) => {
      if (!conversation.updated_time) {
        return false
      }
      const updatedAt = new Date(conversation.updated_time)
      return Number.isFinite(updatedAt.getTime()) && updatedAt >= range.fromAt
    })
  } catch (error) {
    const classification = classifyMessengerBackfillError(error)
    if (classification === "unavailable") {
      await advanceCheckpoint(data, range.toAt)
      return
    }
    logger.warn(
      { err: error, integrationId: data.integrationId, classification },
      "[messenger-auto-backfill] activity probe failed",
    )
    throw error
  }

  if (!hasActivity) {
    await advanceCheckpoint(data, range.toAt)
    return
  }

  try {
    const run = await messengerBackfillService.schedule({
      workspaceId: data.workspaceId,
      integrationId: data.integrationId,
      requestedByUserId: null,
      rangeFromAt: range.fromAt,
      rangeToAt: range.toAt,
      includeContacts: true,
      includeMessages: true,
      triggerSource: "auto",
    })
    await integrationQueue.add(
      IntegrationJobAction.messengerBackfill,
      {
        type: IntegrationJobAction.messengerBackfill,
        data: { runId: run.runId, workspaceId: data.workspaceId },
      },
      {
        jobId: buildMessengerBackfillJobId({ runId: run.runId, attempts: 0 }),
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { count: 100 },
      },
    )
  } catch (error) {
    // Manual and automatic runs share the partial unique index. A manual run
    // wins; leaving the checkpoint unchanged makes the next tick catch up.
    if (
      error instanceof ChatbotXException &&
      error.code === "messengerBackfillAlreadyRunning"
    ) {
      return
    }
    throw error
  }
}

const advanceCheckpoint = (
  data: IntegrationJobMessengerAutoBackfill["data"],
  checkpoint: Date,
) =>
  messengerIntegrationService.advanceAutoBackfillCheckpoint({
    id: data.integrationId,
    workspaceId: data.workspaceId,
    checkpoint,
  })
