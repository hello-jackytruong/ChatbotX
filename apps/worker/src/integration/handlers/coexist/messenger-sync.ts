import {
  coexistImportService,
  coexistService,
  messengerIntegrationService,
  workspaceService,
} from "@chatbotx.io/business"
import { logProviderError } from "@chatbotx.io/business/error-log"
import { findOrFail } from "@chatbotx.io/database/client"
import { inboxModel } from "@chatbotx.io/database/schema"
import {
  listConversations,
  type MessengerConversation,
} from "@chatbotx.io/integration-messenger/apis/sync"
import {
  type BucUsage,
  concurrencyForUsage,
} from "@chatbotx.io/integration-messenger/apis/usage"
import type { IncomingContact } from "@chatbotx.io/sdk"
import {
  IntegrationJobAction,
  type IntegrationJobCoexistMessengerSync,
  integrationQueue,
} from "@chatbotx.io/worker-config"
import pLimit from "p-limit"
import { logger } from "../../../lib/logger"
import {
  applyCoexistActivityUpdates,
  bulkImportContacts,
  bulkImportMessages,
  type CoexistActivityUpdate,
  type ContactImportLink,
  createHistoricalIdFactory,
  maxNumericId,
} from "./bulk-historical-import"
import { filterConversationWindow } from "./conversation-window"
import {
  fetchConvMessages,
  messengerAuthSchema,
  participantSourceId,
  STORE_WINDOW_MS,
  splitName,
  withInlineRetry,
} from "./messenger-helpers"

/** Default Graph concurrency when BUC usage signals "plenty of budget". */
const DEFAULT_CONCURRENCY = 5

/**
 * Active wall-time budget per chunk. When exceeded, the job persists state and
 * either hot-chains a continuation enqueue or yields to the scheduler.
 */
const CHUNK_BUDGET_MS = 4 * 60 * 1000

type ConvFilter = {
  convsToProcess: MessengerConversation[]
  stopAll: boolean
  oldestConvProcessed: Date | null
}

/**
 * Apply within-run frontier + cross-run ceiling filters to one Graph
 * conversations page. Shared by both phases since each phase walks
 * `/conversations` DESC and tracks its own `lastSyncedAt` watermark.
 *
 * Thin wrapper preserving the original positional signature/shape over the
 * generic `filterConversationWindow` (moved to `./conversation-window.ts` in
 * Phase 4a of the Automatic Customer Scan plan so the scan engine can reuse
 * the same window logic) — call sites and tests are unchanged.
 */
function filterConversations(
  conversations: MessengerConversation[],
  frontier: Date | null,
  ceiling: Date | null,
  currentOldest: Date | null,
): ConvFilter {
  const result = filterConversationWindow({
    items: conversations,
    getUpdatedAt: (conv) =>
      conv.updated_time ? new Date(conv.updated_time) : null,
    frontier,
    ceiling,
    currentOldest,
  })
  return {
    convsToProcess: result.itemsToProcess,
    stopAll: result.stopAll,
    oldestConvProcessed: result.oldestProcessed,
  }
}

type SyncContext = {
  runId: string
  integrationId: string
  workspaceId: string
  pageId: string
  accessToken: string
  version: string | undefined
  inbox: Awaited<ReturnType<typeof findOrFail<typeof inboxModel>>>
  defaultCountry: string | null
  ceiling: Date | null
  applyBucThrottle: (usage: BucUsage | null | undefined) => void
  respectPause: () => Promise<void>
  getLimit: () => ReturnType<typeof pLimit>
  jobStart: number
  /** Mutated by handlers to surface non-fatal failures into currentError. */
  errorRef: { current: string | undefined }
  /** `IntegrationMessenger.coexistAiReadsSyncedHistory` — when false (the
   *  default), `Conversation.aiContextLastMessageId` is advanced to the newest
   *  sync-inserted message id so the AI ignores this synced history; when
   *  true, the marker is left untouched and the AI reads the history. */
  aiReadsSyncedHistory: boolean
}

type PhaseResult = {
  /** True when the phase has no more pages to process. */
  done: boolean
  /** Last per-page oldest conv-time, persisted to lastSyncedAt. */
  oldestConvProcessed: Date | null
  pageNumber: number
}

type ListConversationsPage = Awaited<ReturnType<typeof listConversations>>

type PageHandler = (args: {
  conversations: ListConversationsPage
  filtered: ConvFilter
  pageNumber: number
  currentOldest: Date | null
}) => Promise<Date | null>

/**
 * Walk `/me/conversations` DESC pages until cursor exhausts, ceiling stops
 * the walk, or the chunk budget expires. Handles inline retry, BUC throttle,
 * heartbeat, pause, and the frontier/ceiling filter on each page. The phase's
 * `onPage` callback runs per-page side effects (DB writes, sub-fetches) and
 * returns the new oldest-processed watermark to persist as `lastSyncedAt`.
 */
async function walkConversationsPages(
  ctx: SyncContext,
  phaseName: "contacts" | "messages",
  frontier: Date | null,
  onPage: PageHandler,
  maxPages = Number.POSITIVE_INFINITY,
): Promise<PhaseResult> {
  const { runId, pageId, jobStart } = ctx
  let oldestConvProcessed: Date | null = frontier
  let pageCursor: string | undefined
  let pageNumber = 0

  while (true) {
    if (Date.now() - jobStart >= CHUNK_BUDGET_MS) {
      return { done: false, oldestConvProcessed, pageNumber }
    }

    await ctx.respectPause()
    pageNumber += 1

    const conversations = await withInlineRetry(() =>
      listConversations({
        pageId,
        accessToken: ctx.accessToken,
        version: ctx.version,
        after: pageCursor,
      }),
    )
    ctx.applyBucThrottle(conversations.bucUsage)
    // Honour any BUC-imposed pause immediately — including when this is the
    // final page and the loop will exit without a subsequent respectPause().
    await ctx.respectPause()

    await coexistService.updateProgress({
      runId,
      fields: {
        currentStep: `phase=${phaseName} page ${pageNumber} — ${conversations.data.length} conversations`,
        lastHeartbeatAt: new Date(),
      },
    })

    const filtered = filterConversations(
      conversations.data,
      frontier,
      ctx.ceiling,
      oldestConvProcessed,
    )

    oldestConvProcessed = await onPage({
      conversations,
      filtered,
      pageNumber,
      currentOldest: oldestConvProcessed,
    })

    pageCursor = conversations.after

    if (!pageCursor || filtered.stopAll || pageNumber >= maxPages) {
      return { done: true, oldestConvProcessed, pageNumber }
    }
  }
}

/**
 * Phase 1 — prepare only the newest page of Contacts. Phase 2 upserts Contacts
 * again per page before importing Messages, so recent inbox data becomes
 * visible immediately instead of waiting for a full historical contact scan.
 */
async function runContactsPhase(ctx: SyncContext): Promise<PhaseResult> {
  const { runId, workspaceId, pageId, inbox } = ctx

  const runRow = await coexistService.findLastSyncedAt({ runId })

  if (!runRow) {
    return { done: true, oldestConvProcessed: null, pageNumber: 0 }
  }

  return walkConversationsPages(
    ctx,
    "contacts",
    runRow.lastSyncedAt,
    async ({ filtered, pageNumber }) => {
      const contactBatch: IncomingContact[] = []
      for (const conv of filtered.convsToProcess) {
        const participant = participantSourceId(conv, pageId)
        if (!participant) {
          continue
        }
        const { firstName, lastName } = splitName(participant.name)
        contactBatch.push({
          sourceId: participant.sourceId,
          firstName,
          lastName,
        })
      }

      let pageResult: Awaited<ReturnType<typeof bulkImportContacts>>
      try {
        pageResult = await bulkImportContacts({
          inbox,
          workspaceId,
          contacts: contactBatch,
        })
      } catch (error) {
        const errMsg =
          error instanceof Error ? error.message : "Unknown bulk import error"
        logger.error(
          { error, runId, pageNumber },
          "[coexist] Messenger contact bulk import threw — page lost",
        )
        pageResult = {
          importedContacts: 0,
          skippedContacts: 0,
          contactInboxIds: new Map(),
          newContactInboxIds: new Map(),
        }
        ctx.errorRef.current = `phase=contacts page ${pageNumber} bulk import failed: ${errMsg}`
      }

      if (pageResult.failureReason) {
        ctx.errorRef.current = `phase=contacts page ${pageNumber}: ${pageResult.failureReason}`
      }

      await coexistService.incrementProgress({
        runId,
        increments: {
          currentScan: filtered.convsToProcess.length,
          importedContactCount: pageResult.importedContacts,
          skippedCount: pageResult.skippedContacts,
        },
        fields: {
          lastSyncedAt: filtered.oldestConvProcessed,
          currentStep: `phase=contacts page ${pageNumber} processed`,
          currentError: ctx.errorRef.current ?? null,
          lastHeartbeatAt: new Date(),
        },
      })

      return filtered.oldestConvProcessed
    },
    1,
  )
}

/**
 * Phase 2 — re-walk `/me/conversations` DESC. Each page first upserts its
 * Contacts, then fetches and stores Messages for those same conversations.
 * Frontier resets to NULL on transition so the newest inbox data appears first
 * while older history continues importing in the background.
 */
async function runMessagesPhase(ctx: SyncContext): Promise<PhaseResult> {
  const { runId, workspaceId, pageId, inbox } = ctx

  const runRow = await coexistService.findLastSyncedAt({ runId })

  if (!runRow) {
    return { done: true, oldestConvProcessed: null, pageNumber: 0 }
  }

  const fallbackCutoff = new Date(Date.now() - STORE_WINDOW_MS)
  // ONE factory shared across all per-conv bulkImportMessages calls in this
  // chunk — its per-import used-set probes same-ms IDs that collide across convs
  // (H1). IDs are derived from (createdAt, contactInboxId, sourceId),
  // independent of runId.
  const idFactory = createHistoricalIdFactory()

  return walkConversationsPages(
    ctx,
    "messages",
    runRow.lastSyncedAt,
    async ({ filtered, pageNumber, currentOldest }) => {
      // Single pass: extract participant per conversation.
      const convsByParticipant = new Map<string, MessengerConversation>()
      const contactBatch: IncomingContact[] = []
      for (const conv of filtered.convsToProcess) {
        const p = participantSourceId(conv, pageId)
        if (!p) {
          continue
        }
        convsByParticipant.set(p.sourceId, conv)
        const { firstName, lastName } = splitName(p.name)
        contactBatch.push({ sourceId: p.sourceId, firstName, lastName })
      }
      const sourceIds = Array.from(convsByParticipant.keys())

      let pageImportedContacts = 0
      let pageSkippedContacts = 0
      try {
        const contactResult = await bulkImportContacts({
          inbox,
          workspaceId,
          contacts: contactBatch,
        })
        pageImportedContacts = contactResult.importedContacts
        pageSkippedContacts = contactResult.skippedContacts
        if (contactResult.failureReason) {
          ctx.errorRef.current = `phase=messages page ${pageNumber} contacts: ${contactResult.failureReason}`
        }
      } catch (error) {
        const errMsg =
          error instanceof Error ? error.message : "Unknown bulk import error"
        logger.error(
          { error, runId, pageNumber },
          "[coexist] Messenger page contact import failed",
        )
        ctx.errorRef.current = `phase=messages page ${pageNumber} contact import failed: ${errMsg}`
      }

      // Single JOIN resolves ContactInbox + Conversation in one round trip.
      const linkBySource = new Map<string, ContactImportLink>()
      if (sourceIds.length > 0) {
        const rows = await coexistImportService.listContactLinksBySourceIds({
          inboxId: inbox.id,
          sourceIds,
        })
        for (const r of rows) {
          if (!r.conversationId) {
            continue
          }
          linkBySource.set(r.sourceId, {
            contactInboxId: r.contactInboxId,
            contactId: r.contactId,
            conversationId: r.conversationId,
          })
        }
      }

      let pageImported = 0
      let pageSkipped = 0
      let pageFailed = 0
      let pageOldest: Date | null = currentOldest
      // Collected across all convs in this chunk, then flushed once per table
      // after the barrier — keeps the activity bumps out of the per-page loop.
      const activityUpdates: CoexistActivityUpdate[] = []

      const limit = ctx.getLimit()
      await Promise.all(
        Array.from(convsByParticipant, ([sourceId, conv]) =>
          limit(async () => {
            const link = linkBySource.get(sourceId)
            if (!link) {
              // Contact rejected in phase 1 — no target to write to. Skip.
              return
            }

            const convTime = conv.updated_time
              ? new Date(conv.updated_time)
              : null
            const cutoff = convTime
              ? new Date(convTime.getTime() - STORE_WINDOW_MS)
              : fallbackCutoff

            // Newest message time across this conv's pages — one activity bump
            // per conv (not per page).
            let convNewest: Date | null = null
            let convOldest: Date | null = null
            let convNewestIncoming: Date | null = null
            let convNewestMessageId: string | null = null

            try {
              await fetchConvMessages({
                conversationId: conv.id,
                accessToken: ctx.accessToken,
                version: ctx.version,
                cutoff,
                ceiling: ctx.ceiling,
                pageId,
                defaultCountry: ctx.defaultCountry,
                applyBucThrottle: ctx.applyBucThrottle,
                respectPause: ctx.respectPause,
                // M3: flush each Graph page immediately — `pageDiscovered` is
                // the live enrichment object so all data found so far is passed.
                onPage: async (pageMessages, pageDiscovered) => {
                  const result = await bulkImportMessages({
                    workspaceId,
                    runId,
                    contactInboxId: link.contactInboxId,
                    contactId: link.contactId,
                    conversationId: link.conversationId,
                    messages: pageMessages,
                    contactEnrichment: pageDiscovered,
                    idFactory,
                  })
                  pageImported += result.importedMessages
                  pageSkipped += result.skippedMessages
                  if (
                    result.newestMessageAt &&
                    (!convNewest || convNewest < result.newestMessageAt)
                  ) {
                    convNewest = result.newestMessageAt
                  }
                  if (
                    result.oldestMessageAt &&
                    (!convOldest || convOldest > result.oldestMessageAt)
                  ) {
                    convOldest = result.oldestMessageAt
                  }
                  if (
                    result.newestIncomingMessageAt &&
                    (!convNewestIncoming ||
                      convNewestIncoming < result.newestIncomingMessageAt)
                  ) {
                    convNewestIncoming = result.newestIncomingMessageAt
                  }
                  convNewestMessageId = maxNumericId(
                    convNewestMessageId,
                    result.newestMessageId,
                  )
                },
              })

              const aiMarkerMessageId = ctx.aiReadsSyncedHistory
                ? null
                : convNewestMessageId
              if (convNewest || aiMarkerMessageId) {
                activityUpdates.push({
                  contactInboxId: link.contactInboxId,
                  contactId: link.contactId,
                  conversationId: link.conversationId,
                  newestMessageAt: convNewest,
                  oldestMessageAt: convOldest ?? convNewest,
                  newestIncomingMessageAt: convNewestIncoming,
                  aiMarkerMessageId,
                })
              }

              if (convTime && (pageOldest === null || convTime < pageOldest)) {
                pageOldest = convTime
              }
            } catch (error) {
              const errMsg =
                error instanceof Error
                  ? error.message
                  : "Unknown message fetch error"
              logger.error(
                { error, conversationId: conv.id, runId },
                "[coexist] Messenger phase=messages conv failed",
              )
              ctx.errorRef.current = `conv ${conv.id} message fetch failed: ${errMsg}`
              pageFailed += 1
            }
          }),
        ),
      )

      // One UPDATE per table for the whole chunk (not per conv/page in the loop).
      await applyCoexistActivityUpdates(activityUpdates, { workspaceId })

      await coexistService.incrementProgress({
        runId,
        increments: {
          importedContactCount: pageImportedContacts,
          importedMessageCount: pageImported,
          skippedCount: pageSkipped + pageSkippedContacts,
          failedCount: pageFailed,
        },
        fields: {
          lastSyncedAt: pageOldest,
          currentStep: `phase=messages page ${pageNumber} processed`,
          currentError: ctx.errorRef.current ?? null,
          lastHeartbeatAt: new Date(),
        },
      })

      return pageOldest
    },
  )
}

/**
 * Page-per-job historical Messenger sync. Splits into two sequential phases:
 *
 *  - **contacts** — prepare only the newest page of Contacts.
 *  - **messages** — re-walk DESC; each page upserts Contacts and immediately
 *    imports Messages before continuing toward older history.
 *
 * Phase boundary is persisted on `CoexistSyncRun.messengerSyncPhase`. When
 * phase=contacts finishes, the run flips to phase=messages with
 * `lastSyncedAt=NULL` so phase 2 walks from newest. The job hot-chains a
 * continuation when the chunk budget exhausts.
 *
 * Idempotent via `Message_(contactInboxId, sourceId)_key`.
 */
export const coexistMessengerSync = async (
  data: IntegrationJobCoexistMessengerSync["data"],
): Promise<void> => {
  const { runId, integrationId, workspaceId } = data
  const jobStart = Date.now()

  const failRun = async (currentError: string): Promise<void> => {
    await coexistService.markFailed({ runId, currentError })
  }

  // NO workspace scope — the mismatch branch below deliberately distinguishes
  // "not found" from "workspaceId mismatch" (do NOT substitute a
  // workspace-scoped lookup here, which would collapse that distinction).
  const integration = await messengerIntegrationService.findById({
    id: integrationId,
  })
  if (!integration) {
    logger.warn({ integrationId }, "[coexist] Messenger integration gone")
    await failRun("Messenger integration not found")
    return
  }
  if (integration.workspaceId !== workspaceId) {
    logger.warn(
      { integrationId, workspaceId, rowWorkspaceId: integration.workspaceId },
      "[coexist] Messenger sync workspaceId mismatch — refusing",
    )
    await failRun("workspaceId mismatch between integration and run")
    return
  }
  if (!integration.coexistEnabled) {
    logger.info(
      { integrationId },
      "[coexist] Messenger sync skipped — disabled",
    )
    await failRun("Coexist disabled on integration")
    return
  }

  const parsedAuth = messengerAuthSchema.safeParse(integration.auth)
  if (!parsedAuth.success) {
    logger.error(
      { integrationId, error: parsedAuth.error.message },
      "[coexist] Messenger auth jsonb failed validation",
    )
    await failRun(`Messenger auth invalid: ${parsedAuth.error.message}`)
    return
  }
  const accessToken = parsedAuth.data.tokens.accessToken
  const version = parsedAuth.data.metadata?.version
  const { pageId } = integration

  const inbox = await findOrFail({
    table: inboxModel,
    where: { id: integration.inboxId },
    message: "Inbox not found",
  })

  const workspace = await workspaceService.find({ where: { id: workspaceId } })
  const defaultCountry = workspace?.targetCountry ?? null

  const initRow = await coexistService.findInitState({ runId })

  if (!initRow) {
    logger.warn({ runId }, "[coexist] CoexistSyncRun row gone — abandoning")
    return
  }

  const ceiling = await coexistService.findResumeCeiling({
    integrationId,
    channel: "messenger",
    currentRunId: runId,
  })
  const attempts = initRow.attempts

  // Optimistic claim: only one worker may flip status→running at a time.
  const claimedRun = await coexistService.reclaimRunForRetry({
    runId,
    touchUpdatedAt: true,
  })

  if (!claimedRun) {
    logger.warn(
      { runId, integrationId },
      "[coexist] Messenger run already claimed by another worker — abandoning",
    )
    return
  }

  // ── Adaptive concurrency state (BUC-driven) ──────────────────────────────
  let currentConcurrency = DEFAULT_CONCURRENCY
  let currentLimit = pLimit(currentConcurrency)
  let pauseUntil = 0

  // Maximum in-process pause duration for a BUC budget exhaustion. A larger
  // value would hold the worker concurrency slot for too long and exceed the
  // chunk budget. Future improvement: re-enqueue with a BullMQ delay instead.
  const MAX_PAUSE_SEC = 300

  const applyBucThrottle = (usage: BucUsage | null | undefined): void => {
    const next = concurrencyForUsage(usage ?? null)
    if (next === 0) {
      const waitSec = Math.min(
        usage?.estimatedTimeToRegainAccess ?? 60,
        MAX_PAUSE_SEC,
      )
      pauseUntil = Math.max(pauseUntil, Date.now() + waitSec * 1000)
      if (currentConcurrency !== 1) {
        currentConcurrency = 1
        currentLimit = pLimit(1)
      }
      logger.warn(
        { waitSec, integrationId },
        "[coexist] BUC budget exhausted — pausing Graph calls",
      )
      return
    }
    if (next !== currentConcurrency) {
      currentConcurrency = next
      currentLimit = pLimit(next)
      logger.info(
        { next, integrationId },
        "[coexist] BUC throttle adjusted Messenger concurrency",
      )
    }
  }

  const respectPause = async (): Promise<void> => {
    if (Date.now() < pauseUntil) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, pauseUntil - Date.now()),
      )
    }
  }

  const errorRef = { current: initRow.currentError ?? undefined }
  const ctx: SyncContext = {
    runId,
    integrationId,
    workspaceId,
    pageId,
    accessToken,
    version,
    inbox,
    defaultCountry,
    ceiling,
    applyBucThrottle,
    respectPause,
    getLimit: () => currentLimit,
    jobStart,
    errorRef,
    aiReadsSyncedHistory: integration.coexistAiReadsSyncedHistory,
  }

  let finalStatus: "succeeded" | "failed" | "partial" | null = null
  let continueLater = false
  let lastPageNumber = 0
  let currentPhase = initRow.messengerSyncPhase

  try {
    // Run phases sequentially; each loop iteration either advances a phase
    // to completion, transitions, or yields when the chunk budget exhausts.
    while (true) {
      if (Date.now() - jobStart >= CHUNK_BUDGET_MS) {
        continueLater = true
        break
      }

      if (currentPhase === "contacts") {
        const result = await runContactsPhase(ctx)
        lastPageNumber = result.pageNumber
        if (!result.done) {
          continueLater = true
          break
        }
        // Transition to phase 2 — reset frontier so messages walks from newest.
        await coexistService.updateProgress({
          runId,
          fields: {
            messengerSyncPhase: "messages",
            lastSyncedAt: null,
            currentStep: "contacts done — start message phase",
            lastHeartbeatAt: new Date(),
          },
        })
        currentPhase = "messages"
        continue
      }

      // phase === "messages"
      const result = await runMessagesPhase(ctx)
      lastPageNumber = result.pageNumber
      if (!result.done) {
        continueLater = true
        break
      }

      // Both phases complete — derive terminal status from counters.
      const terminal = await coexistService.findTerminalCounters({ runId })

      if (
        terminal &&
        terminal.failedCount > 0 &&
        (terminal.importedMessageCount > 0 || terminal.skippedCount > 0)
      ) {
        finalStatus = "partial"
      } else if (terminal && terminal.failedCount > 0) {
        finalStatus = "failed"
      } else {
        finalStatus = "succeeded"
      }
      break
    }

    let continuationReleased = false
    if (continueLater) {
      try {
        // Release the run before hot-chaining. Otherwise the continuation
        // immediately sees a fresh `running` heartbeat and abandons, leaving
        // the run parked until the stale-run scheduler eventually recovers it.
        await coexistService.updateProgress({
          runId,
          fields: { status: "init", lastHeartbeatAt: new Date() },
        })
        continuationReleased = true
        await integrationQueue.add(
          IntegrationJobAction.coexistMessengerSync,
          {
            type: IntegrationJobAction.coexistMessengerSync,
            data: { runId, integrationId, workspaceId },
          },
          {
            jobId: `coexist-run-${runId}-${attempts}-page-${lastPageNumber + 1}`,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: { count: 100 },
          },
        )
        logger.info(
          { runId, lastPageNumber, integrationId, phase: currentPhase },
          "[coexist] Messenger sync chunk done — continuation enqueued",
        )
      } catch (error) {
        logger.error(
          { error, runId },
          "[coexist] Messenger continuation enqueue failed — fallback to scheduler",
        )
        if (!continuationReleased) {
          await coexistService.updateProgress({
            runId,
            fields: { status: "init", lastHeartbeatAt: new Date() },
          })
        }
      }
    }
  } catch (error) {
    finalStatus = "failed"
    errorRef.current =
      error instanceof Error
        ? error.message
        : "Unknown error during Messenger sync"
    logger.error(error, "[coexist] Messenger sync encountered fatal error")
    // `messenger`, not `whatsapp`: coexist spans three channels and each sync
    // entry point must report the channel it actually pulled from.
    await logProviderError({
      provider: "messenger",
      workspaceId,
      error,
    })
  } finally {
    if (finalStatus !== null) {
      await coexistService.updateProgress({
        runId,
        fields: {
          status: finalStatus,
          finishedAt: new Date(),
          lastHeartbeatAt: new Date(),
          currentStep: "done",
          currentError: errorRef.current ?? null,
        },
      })
    }
  }

  logger.info(
    {
      integrationId,
      runId,
      finalStatus,
      currentPhase,
      continued: continueLater,
    },
    "[coexist] Messenger sync chunk complete",
  )
}
