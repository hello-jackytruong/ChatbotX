import {
  messengerBackfillService,
  messengerIntegrationService,
} from "@chatbotx.io/business"
import { getChildLogger } from "@chatbotx.io/logger"
import {
  distributedLock,
  distributedStore,
  isLockAcquisitionError,
} from "@chatbotx.io/redis"
import {
  buildMessengerAutoBackfillJobId,
  buildMessengerBackfillJobId,
  IntegrationJobAction,
  integrationQueue,
} from "@chatbotx.io/worker-config"
import { env } from "../../env"

const LOCK_KEY = "schedule:reconcile-messenger-history"
const LOCK_SECONDS = 4 * 60
const LOCK_WAIT_SECONDS = 2
const PAGE_SIZE = 250
const MAX_ATTEMPTS = 5
const log = getChildLogger("reconcile-messenger-history")

export async function reconcileMessengerHistory(): Promise<void> {
  try {
    await distributedLock.runExclusive({
      key: LOCK_KEY,
      timeoutInSeconds: LOCK_SECONDS,
      retryTimeoutInSeconds: LOCK_WAIT_SECONDS,
      fn: async () => {
        await recoverPendingRuns()
        if (env.MESSENGER_AUTO_BACKFILL_ENABLED) {
          await enqueueConnectedPages()
        }
      },
    })
  } catch (error) {
    if (
      isLockAcquisitionError(error, LOCK_KEY) &&
      (await distributedStore.exists(LOCK_KEY))
    ) {
      return
    }
    throw error
  }
}

const recoverPendingRuns = async (): Promise<void> => {
  await messengerBackfillService.markMaxAttemptsFailed({
    maxAttempts: MAX_ATTEMPTS,
  })
  const runs = await messengerBackfillService.pickDue({
    batchSize: PAGE_SIZE,
    maxAttempts: MAX_ATTEMPTS,
  })
  for (const run of runs) {
    await integrationQueue
      .add(
        IntegrationJobAction.messengerBackfill,
        {
          type: IntegrationJobAction.messengerBackfill,
          data: { runId: run.id, workspaceId: run.workspaceId },
        },
        {
          jobId: buildMessengerBackfillJobId({
            runId: run.id,
            attempts: run.attempts,
          }),
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: { count: 100 },
        },
      )
      .catch((error) => {
        log.error({ err: error, runId: run.id }, "pending run enqueue failed")
      })
  }
}

const enqueueConnectedPages = async (): Promise<void> => {
  const now = Date.now()
  const intervalMs = env.MESSENGER_AUTO_BACKFILL_INTERVAL_MINUTES * 60 * 1000
  const timeBucket = Math.floor(now / intervalMs)
  let afterId: string | undefined

  while (true) {
    const rows = await messengerIntegrationService.listConnectedForAutoBackfill(
      { afterId, limit: PAGE_SIZE },
    )
    if (rows.length === 0) {
      return
    }
    for (const row of rows) {
      await integrationQueue
        .add(
          IntegrationJobAction.messengerAutoBackfill,
          {
            type: IntegrationJobAction.messengerAutoBackfill,
            data: { integrationId: row.id, workspaceId: row.workspaceId },
          },
          {
            jobId: buildMessengerAutoBackfillJobId({
              integrationId: row.id,
              timeBucket,
            }),
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: { count: 100 },
          },
        )
        .catch((error) => {
          log.error(
            { err: error, integrationId: row.id },
            "auto probe enqueue failed",
          )
        })
    }
    if (rows.length < PAGE_SIZE) {
      return
    }
    afterId = rows.at(-1)?.id
  }
}
