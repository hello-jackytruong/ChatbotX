import {
  bulkImportChannelContacts,
  inboxService,
  messengerBackfillService,
  messengerIntegrationService,
  workspaceService,
} from "@chatbotx.io/business"
import { toPublicErrorMessage } from "@chatbotx.io/business/errors"
import type { CoexistRunWriteGuard } from "@chatbotx.io/database/repositories"
import {
  listConversations,
  type MessengerConversation,
} from "@chatbotx.io/integration-messenger/apis/sync"
import {
  type BucUsage,
  concurrencyForUsage,
} from "@chatbotx.io/integration-messenger/apis/usage"
import { distributedLock } from "@chatbotx.io/redis"
import type { IncomingContact } from "@chatbotx.io/sdk"
import {
  buildMessengerBackfillPageJobId,
  IntegrationJobAction,
  type IntegrationJobMessengerBackfill,
  integrationQueue,
} from "@chatbotx.io/worker-config"
import { logger } from "../../../lib/logger"
import {
  applyCoexistActivityUpdates,
  bulkImportMessages,
  createHistoricalIdFactory,
} from "../coexist/bulk-historical-import"
import { enqueueAttachmentDownloadJobs } from "../coexist/enqueue-attachment-downloads"
import {
  messengerAuthSchema,
  splitName,
  withInlineRetry,
} from "../coexist/messenger-helpers"
import { enqueueProfileSnapshotJobs } from "../profile-snapshot/queue"
import { classifyMessengerBackfillError } from "./error-policy"
import {
  type MessengerBackfillWalkInterruption,
  walkMessengerConversationRange,
} from "./message-walker"
import { shouldStopConversationWalk } from "./range"

const CHUNK_BUDGET_MS = 4 * 60 * 1000
const LOCK_SECONDS = 5 * 60
const LOCK_WAIT_SECONDS = 1
const GLOBAL_LOCK_KEY = "messenger-backfill:global"

type BackfillContext = {
  runId: string
  workspaceId: string
  integrationId: string
  pageId: string
  accessToken: string
  version?: string
  inbox: NonNullable<Awaited<ReturnType<typeof inboxService.find>>>
  defaultCountry: string | null
  fromAt: Date
  toAt: Date
  includeMessages: boolean
  triggerSource: string
  expect: CoexistRunWriteGuard
  applyBucThrottle: (usage: BucUsage | null | undefined) => void
  respectPause: () => Promise<void>
}

type ConversationResult = {
  importedContacts: number
  importedMessages: number
  skipped: number
  unavailable: number
  failed: number
  outcome: "completed" | MessengerBackfillWalkInterruption | "abandoned"
  error?: string
}

type BackfillResumeState = {
  outerCursor?: string
  conversationIndex: number
  messageCursor?: string
}

const RESUME_STATE_PREFIX = "messenger-backfill-v1:"

class ClaimLostError extends Error {}
class PageCommitError extends Error {
  constructor(cause: unknown) {
    super("Messenger backfill page could not be committed.", { cause })
  }
}

/**
 * Serializes all Messenger history imports on the production worker while the
 * nested integration lock documents/enforces the narrower Page invariant.
 * A lock race bubbles to the worker's standard lock-contention deferral.
 */
export const runMessengerBackfill = async (
  data: IntegrationJobMessengerBackfill["data"],
): Promise<void> => {
  const pending = await messengerBackfillService.findRunById({
    runId: data.runId,
  })
  if (pending?.type !== "backfill") {
    return
  }
  await distributedLock.runExclusive({
    key: GLOBAL_LOCK_KEY,
    timeoutInSeconds: LOCK_SECONDS,
    retryTimeoutInSeconds: LOCK_WAIT_SECONDS,
    fn: () =>
      distributedLock.runExclusive({
        key: `messenger-backfill:integration:${pending.integrationId}`,
        timeoutInSeconds: LOCK_SECONDS,
        retryTimeoutInSeconds: LOCK_WAIT_SECONDS,
        fn: () => runClaimedBackfill(data),
      }),
  })
}

const runClaimedBackfill = async (
  data: IntegrationJobMessengerBackfill["data"],
): Promise<void> => {
  const run = await messengerBackfillService.claim({ runId: data.runId })
  if (!run) {
    return
  }

  const expect: CoexistRunWriteGuard = {
    status: "running",
    claimToken: run.claimToken,
  }
  const fail = (message: string) =>
    messengerBackfillService.finish({
      runId: run.id,
      status: "failed",
      currentError: message,
      expect,
    })

  if (run.workspaceId !== data.workspaceId) {
    await fail("Workspace mismatch; the backfill job was rejected.")
    return
  }
  if (
    !(run.rangeFromAt && run.rangeToAt) ||
    run.includeContacts === null ||
    run.includeMessages === null ||
    !(run.includeContacts || run.includeMessages)
  ) {
    await fail("Messenger backfill configuration is incomplete.")
    return
  }
  if (run.cancelRequestedAt) {
    await fail("Cancelled by a workspace administrator.")
    return
  }

  const integration = await messengerIntegrationService.findByIdForWorkspace({
    id: run.integrationId,
    workspaceId: run.workspaceId,
  })
  if (!integration) {
    await fail("Messenger Page is disconnected. Reconnect it and retry.")
    return
  }
  const auth = messengerAuthSchema.safeParse(integration.auth)
  if (!auth.success) {
    await fail(
      "Messenger credentials are invalid. Reconnect the Page and retry.",
    )
    return
  }
  const inbox = await inboxService.find({
    where: { id: integration.inboxId, workspaceId: run.workspaceId },
  })
  if (!inbox) {
    await fail("Messenger inbox is no longer available.")
    return
  }
  const workspace = await workspaceService.find({
    where: { id: run.workspaceId },
  })

  let pauseUntil = 0
  const applyBucThrottle = (usage: BucUsage | null | undefined): void => {
    if (concurrencyForUsage(usage ?? null) === 0) {
      const waitSeconds = Math.min(usage?.estimatedTimeToRegainAccess ?? 30, 45)
      pauseUntil = Math.max(pauseUntil, Date.now() + waitSeconds * 1000)
    }
  }
  const respectPause = async (): Promise<void> => {
    const waitMs = pauseUntil - Date.now()
    if (waitMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
    }
  }

  const ctx: BackfillContext = {
    runId: run.id,
    workspaceId: run.workspaceId,
    integrationId: run.integrationId,
    pageId: integration.pageId,
    accessToken: auth.data.tokens.accessToken,
    version: auth.data.metadata?.version,
    inbox,
    defaultCountry: workspace?.targetCountry ?? null,
    fromAt: run.rangeFromAt,
    toAt: run.rangeToAt,
    includeMessages: run.includeMessages,
    triggerSource: run.triggerSource,
    expect,
    applyBucThrottle,
    respectPause,
  }

  try {
    await walkConversationPages(ctx, run.resumeCursor ?? undefined, {
      pageNumber: run.currentPageNumber,
      attempts: run.attempts,
      startedAtMs: Date.now(),
    })
  } catch (error) {
    const classification = classifyMessengerBackfillError(error)
    logger.error(
      { err: error, runId: run.id, classification },
      "[messenger-backfill] run failed",
    )
    if (error instanceof PageCommitError || classification === "retryable") {
      await messengerBackfillService.resetForRetry({
        runId: run.id,
        currentError:
          error instanceof PageCommitError
            ? "Backfill page commit failed; retrying."
            : "Meta is temporarily unavailable; retrying.",
        expect,
      })
      return
    }
    if (classification === "auth" || classification === "permission") {
      await fail(
        "Messenger access expired or lacks permission. Reconnect the Page and retry.",
      )
      return
    }
    await fail(toPublicErrorMessage(error, "Messenger backfill failed."))
  }
}

const walkConversationPages = async (
  ctx: BackfillContext,
  initialCursor: string | undefined,
  state: { pageNumber: number; attempts: number; startedAtMs: number },
): Promise<void> => {
  const initialState = decodeResumeState(initialCursor)
  let cursor = initialState.outerCursor
  let resumeConversationIndex = initialState.conversationIndex
  let resumeMessageCursor = initialState.messageCursor
  let pageNumber = state.pageNumber

  while (true) {
    if (Date.now() - state.startedAtMs >= CHUNK_BUDGET_MS) {
      await enqueueContinuation(ctx, pageNumber, state.attempts)
      return
    }
    if (await cancellationRequested(ctx)) {
      await messengerBackfillService.finish({
        runId: ctx.runId,
        status: "failed",
        currentError: "Cancelled by a workspace administrator.",
        expect: ctx.expect,
      })
      return
    }

    await ctx.respectPause()
    let page: Awaited<ReturnType<typeof listConversations>>
    try {
      page = await withInlineRetry(() =>
        listConversations({
          pageId: ctx.pageId,
          accessToken: ctx.accessToken,
          version: ctx.version,
          after: cursor,
        }),
      )
    } catch (error) {
      if (classifyMessengerBackfillError(error) !== "unavailable") {
        throw error
      }
      const rows = await messengerBackfillService.incrementProgress({
        runId: ctx.runId,
        increments: emptyProgressIncrements({ skippedUnavailableCount: 1 }),
        fields: {
          currentStep: `page ${pageNumber + 1} unavailable`,
          lastHeartbeatAt: new Date(),
        },
        expect: ctx.expect,
      })
      if (rows > 0) {
        await finishCompletedBackfill(ctx)
      }
      return
    }
    ctx.applyBucThrottle(page.bucUsage)
    pageNumber += 1

    let stopAll = false

    for (const [conversationIndex, conversation] of page.data.entries()) {
      if (conversationIndex < resumeConversationIndex) {
        continue
      }
      if (
        conversationIndex > 0 &&
        conversationIndex % 10 === 0 &&
        (await cancellationRequested(ctx))
      ) {
        await messengerBackfillService.finish({
          runId: ctx.runId,
          status: "failed",
          currentError: "Cancelled by a workspace administrator.",
          expect: ctx.expect,
        })
        return
      }
      if (shouldStopConversationWalk(conversation.updated_time, ctx.fromAt)) {
        stopAll = true
        break
      }
      const result = await processConversation(
        ctx,
        conversation,
        state.startedAtMs,
        {
          outerCursor: cursor,
          conversationIndex,
          messageCursor:
            conversationIndex === resumeConversationIndex
              ? resumeMessageCursor
              : undefined,
        },
      )
      if (result.outcome === "abandoned") {
        return
      }
      const rows = await messengerBackfillService.incrementProgress({
        runId: ctx.runId,
        increments: emptyProgressIncrements({
          currentScan: result.outcome === "completed" ? 1 : 0,
          importedContactCount: result.importedContacts,
          importedMessageCount: result.importedMessages,
          skippedCount: result.skipped,
          skippedUnavailableCount: result.unavailable,
          failedCount: result.failed,
        }),
        fields: {
          resumeCursor:
            result.outcome === "completed"
              ? encodeResumeState({
                  outerCursor: cursor,
                  conversationIndex: conversationIndex + 1,
                })
              : undefined,
          currentStep: `conversation ${conversation.id} processed`,
          currentError: result.error,
          lastHeartbeatAt: new Date(),
        },
        expect: ctx.expect,
      })
      if (rows === 0) {
        return
      }
      if (result.outcome === "cancelled") {
        await messengerBackfillService.finish({
          runId: ctx.runId,
          status: "failed",
          currentError: "Cancelled by a workspace administrator.",
          expect: ctx.expect,
        })
        return
      }
      if (result.outcome === "yielded") {
        await enqueueContinuation(ctx, pageNumber, state.attempts)
        return
      }
    }

    const nextCursor = page.after ?? null
    const rows = await messengerBackfillService.incrementProgress({
      runId: ctx.runId,
      increments: emptyProgressIncrements(),
      fields: {
        resumeCursor: nextCursor,
        currentPageNumber: pageNumber,
        currentStep: `page ${pageNumber} processed`,
        lastHeartbeatAt: new Date(),
      },
      expect: ctx.expect,
    })
    if (rows === 0) {
      return
    }

    cursor = page.after
    resumeConversationIndex = 0
    resumeMessageCursor = undefined
    if (stopAll || !cursor) {
      await finishCompletedBackfill(ctx)
      return
    }
  }
}

const emptyProgressIncrements = (
  overrides: Partial<{
    currentScan: number
    importedContactCount: number
    importedMessageCount: number
    skippedCount: number
    skippedUnavailableCount: number
    failedCount: number
  }> = {},
) => ({
  currentScan: 0,
  importedContactCount: 0,
  importedMessageCount: 0,
  skippedCount: 0,
  skippedUnavailableCount: 0,
  failedCount: 0,
  ...overrides,
})

const encodeResumeState = (state: BackfillResumeState): string =>
  `${RESUME_STATE_PREFIX}${JSON.stringify(state)}`

const decodeResumeState = (cursor: string | undefined): BackfillResumeState => {
  if (!cursor) {
    return { conversationIndex: 0 }
  }
  if (!cursor.startsWith(RESUME_STATE_PREFIX)) {
    return { outerCursor: cursor, conversationIndex: 0 }
  }
  try {
    const parsed = JSON.parse(cursor.slice(RESUME_STATE_PREFIX.length)) as {
      outerCursor?: unknown
      conversationIndex?: unknown
      messageCursor?: unknown
    }
    if (
      !Number.isInteger(parsed.conversationIndex) ||
      Number(parsed.conversationIndex) < 0
    ) {
      return { conversationIndex: 0 }
    }
    return {
      outerCursor:
        typeof parsed.outerCursor === "string" ? parsed.outerCursor : undefined,
      conversationIndex: Number(parsed.conversationIndex),
      messageCursor:
        typeof parsed.messageCursor === "string"
          ? parsed.messageCursor
          : undefined,
    }
  } catch {
    return { conversationIndex: 0 }
  }
}

const finishCompletedBackfill = async (ctx: BackfillContext): Promise<void> => {
  const latest = await messengerBackfillService.findRunById({
    runId: ctx.runId,
  })
  const terminalStatus =
    latest && latest.failedCount > 0 ? "partial" : "succeeded"
  const finished = await messengerBackfillService.finish({
    runId: ctx.runId,
    status: terminalStatus,
    currentError: latest?.currentError ?? undefined,
    expect: ctx.expect,
  })
  if (
    finished === 0 ||
    terminalStatus !== "succeeded" ||
    ctx.triggerSource !== "auto"
  ) {
    return
  }
  await messengerIntegrationService
    .advanceAutoBackfillCheckpoint({
      id: ctx.integrationId,
      workspaceId: ctx.workspaceId,
      checkpoint: ctx.toAt,
    })
    .catch((error) => {
      logger.warn(
        { err: error, runId: ctx.runId },
        "[messenger-backfill] checkpoint update failed; next tick will overlap",
      )
    })
}

const processConversation = async (
  ctx: BackfillContext,
  conversation: MessengerConversation,
  startedAtMs: number,
  resume: BackfillResumeState,
): Promise<ConversationResult> => {
  const participant = conversation.participants?.data?.find(
    (entry) => entry.id !== ctx.pageId,
  )
  if (!participant) {
    return {
      importedContacts: 0,
      importedMessages: 0,
      skipped: 1,
      unavailable: 0,
      failed: 0,
      outcome: "completed",
    }
  }

  let link:
    | {
        contactInboxId: string
        contactId: string
        conversationId: string
      }
    | undefined
  let importedContacts = 0
  let importedMessages = 0
  let skipped = 0
  const idFactory = createHistoricalIdFactory()

  const ensureContact = async (): Promise<NonNullable<typeof link>> => {
    if (link) {
      return link
    }
    const { firstName, lastName } = splitName(participant.name)
    const contact: IncomingContact = {
      sourceId: participant.id,
      firstName,
      lastName,
      email: participant.email,
    }
    const result = await bulkImportChannelContacts({
      inbox: ctx.inbox,
      workspaceId: ctx.workspaceId,
      contacts: [contact],
      emitCreatedEvents: false,
    })
    if (result.failureReason) {
      throw new Error(result.failureReason)
    }
    link = result.contactInboxIds.get(participant.id)
    if (!link) {
      throw new Error(
        "Contact link could not be prepared for Messenger history",
      )
    }
    importedContacts += result.importedContacts
    skipped += result.skippedContacts
    if (result.newContactInboxIds.size > 0) {
      await enqueueProfileSnapshotJobs({
        contactInboxIds: [...result.newContactInboxIds.values()].map(
          (item) => item.contactInboxId,
        ),
        inboxId: ctx.inbox.id,
        workspaceId: ctx.workspaceId,
      }).catch((error) => {
        logger.warn(
          { err: error, runId: ctx.runId },
          "[messenger-backfill] profile snapshot enqueue failed",
        )
      })
    }
    const rows = await messengerBackfillService.incrementProgress({
      runId: ctx.runId,
      increments: emptyProgressIncrements({
        importedContactCount: importedContacts,
        skippedCount: skipped,
      }),
      fields: {
        currentStep: `conversation ${conversation.id} contact prepared`,
        lastHeartbeatAt: new Date(),
      },
      expect: ctx.expect,
    })
    if (rows === 0) {
      throw new ClaimLostError()
    }
    importedContacts = 0
    skipped = 0
    return link
  }

  try {
    const walked = await walkMessengerConversationRange({
      conversationId: conversation.id,
      accessToken: ctx.accessToken,
      version: ctx.version,
      pageId: ctx.pageId,
      defaultCountry: ctx.defaultCountry,
      range: { fromAt: ctx.fromAt, toAt: ctx.toAt },
      includeMessages: ctx.includeMessages,
      initialCursor: resume.messageCursor,
      applyBucThrottle: ctx.applyBucThrottle,
      respectPause: ctx.respectPause,
      getInterruption: async () => {
        if (await cancellationRequested(ctx)) {
          return "cancelled"
        }
        return Date.now() - startedAtMs >= CHUNK_BUDGET_MS ? "yielded" : null
      },
      onPage: async ({ messages, discovered, hasInRange, nextCursor }) => {
        try {
          const target = hasInRange ? await ensureContact() : link
          if (!target) {
            const rows = await messengerBackfillService.incrementProgress({
              runId: ctx.runId,
              increments: emptyProgressIncrements(),
              fields: {
                resumeCursor: encodeResumeState({
                  ...resume,
                  messageCursor: nextCursor,
                }),
                currentStep: `conversation ${conversation.id} page processed`,
                lastHeartbeatAt: new Date(),
              },
              expect: ctx.expect,
            })
            if (rows === 0) {
              throw new ClaimLostError()
            }
            return
          }
          const result = await bulkImportMessages({
            workspaceId: ctx.workspaceId,
            runId: ctx.runId,
            contactInboxId: target.contactInboxId,
            contactId: target.contactId,
            conversationId: target.conversationId,
            messages,
            contactEnrichment: discovered,
            idFactory,
          })
          importedMessages += result.importedMessages
          skipped += result.skippedMessages

          // Finish every side effect for this durable page before advancing its
          // cursor. A retry can now repair both activity markers and attachment
          // downloads because bulkImportMessages also resolves existing rows.
          if (result.newestMessageAt || result.newestMessageId) {
            await applyCoexistActivityUpdates(
              [
                {
                  contactInboxId: target.contactInboxId,
                  contactId: target.contactId,
                  conversationId: target.conversationId,
                  newestMessageAt: result.newestMessageAt,
                  oldestMessageAt:
                    result.oldestMessageAt ?? result.newestMessageAt,
                  newestIncomingMessageAt: result.newestIncomingMessageAt,
                  aiMarkerMessageId: result.newestMessageId,
                },
              ],
              { workspaceId: ctx.workspaceId, preserveUnreadState: true },
            )
          }
          await enqueueAttachmentDownloadJobs({
            workspaceId: ctx.workspaceId,
            integrationId: ctx.integrationId,
            channel: "messenger",
            attachmentIds: result.insertedAttachmentIds,
          })

          const rows = await messengerBackfillService.incrementProgress({
            runId: ctx.runId,
            increments: emptyProgressIncrements({
              importedMessageCount: result.importedMessages,
              skippedCount: result.skippedMessages,
            }),
            fields: {
              resumeCursor: encodeResumeState({
                ...resume,
                messageCursor: nextCursor,
              }),
              currentStep: `conversation ${conversation.id} page processed`,
              lastHeartbeatAt: new Date(),
            },
            expect: ctx.expect,
          })
          if (rows === 0) {
            throw new ClaimLostError()
          }
          importedMessages = 0
          skipped = 0
        } catch (error) {
          if (error instanceof ClaimLostError) {
            throw error
          }
          throw new PageCommitError(error)
        }
      },
    })

    return {
      importedContacts,
      importedMessages,
      skipped,
      unavailable: 0,
      failed: 0,
      outcome: walked.status,
    }
  } catch (error) {
    if (error instanceof ClaimLostError) {
      return {
        importedContacts: 0,
        importedMessages: 0,
        skipped: 0,
        unavailable: 0,
        failed: 0,
        outcome: "abandoned",
      }
    }
    if (error instanceof PageCommitError) {
      throw error
    }
    const classification = classifyMessengerBackfillError(error)
    if (classification === "unavailable") {
      return {
        importedContacts,
        importedMessages,
        skipped,
        unavailable: 1,
        failed: 0,
        outcome: "completed",
      }
    }
    if (
      classification === "retryable" ||
      classification === "auth" ||
      classification === "permission"
    ) {
      throw error
    }
    const message = toPublicErrorMessage(error, "Conversation import failed.")
    logger.error(
      { err: error, runId: ctx.runId, conversationId: conversation.id },
      "[messenger-backfill] conversation failed",
    )
    return {
      importedContacts,
      importedMessages,
      skipped,
      unavailable: 0,
      failed: 1,
      outcome: "completed",
      error: `Conversation ${conversation.id}: ${message}`,
    }
  }
}

const enqueueContinuation = async (
  ctx: BackfillContext,
  pageNumber: number,
  attempts: number,
): Promise<void> => {
  const released = await messengerBackfillService.yieldForContinuation({
    runId: ctx.runId,
    expect: ctx.expect,
  })
  if (released === 0) {
    return
  }
  try {
    await integrationQueue.add(
      IntegrationJobAction.messengerBackfill,
      {
        type: IntegrationJobAction.messengerBackfill,
        data: { runId: ctx.runId, workspaceId: ctx.workspaceId },
      },
      {
        jobId: `${buildMessengerBackfillPageJobId({
          runId: ctx.runId,
          attempts,
          pageNumber: pageNumber + 1,
        })}-${crypto.randomUUID()}`,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { count: 100 },
      },
    )
  } catch (error) {
    logger.error(
      { err: error, runId: ctx.runId },
      "[messenger-backfill] continuation enqueue failed",
    )
    await messengerBackfillService.reopenReleased({ runId: ctx.runId })
  }
}

const cancellationRequested = async (
  ctx: BackfillContext,
): Promise<boolean> => {
  const run = await messengerBackfillService.findRunById({ runId: ctx.runId })
  return Boolean(
    !run ||
      run.status !== ctx.expect.status ||
      run.claimToken !== ctx.expect.claimToken ||
      run.cancelRequestedAt,
  )
}
