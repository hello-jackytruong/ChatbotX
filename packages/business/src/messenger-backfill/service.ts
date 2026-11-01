import type { DatabaseClient } from "@chatbotx.io/database/client"
import {
  type CoexistRunProgressInput,
  type CoexistRunWriteGuard,
  coexistSyncRunRepository,
  type IncrementProgressCounters,
  type PickedCoexistRun,
} from "@chatbotx.io/database/repositories"
import type { CoexistSyncRunModel } from "@chatbotx.io/database/types"
import { BaseService } from "../base.service"
import { ChatbotXException } from "../errors"
import { messengerIntegrationService } from "../integration-messenger/service"

export type MessengerBackfillTriggerSource = "manual" | "manual-retry" | "auto"

export type MessengerBackfillScheduleInput = {
  workspaceId: string
  integrationId: string
  requestedByUserId: string | null
  rangeFromAt: Date
  rangeToAt: Date
  includeContacts: boolean
  includeMessages: boolean
  triggerSource: MessengerBackfillTriggerSource
}

type BackfillTerminalStatus = "succeeded" | "partial" | "failed"

const assertValidRange = (input: MessengerBackfillScheduleInput) => {
  const from = input.rangeFromAt.getTime()
  const to = input.rangeToAt.getTime()
  if (
    !(Number.isFinite(from) && Number.isFinite(to)) ||
    from >= to ||
    to > Date.now()
  ) {
    throw new ChatbotXException(
      "Backfill range must start before its upper bound and cannot end in the future.",
      "messengerBackfillRangeInvalid",
      400,
    )
  }

  if (!(input.includeContacts || input.includeMessages)) {
    throw new ChatbotXException(
      "Select Contacts, Messages, or both.",
      "messengerBackfillResourcesRequired",
      400,
    )
  }
}

class MessengerBackfillService extends BaseService {
  async schedule(
    input: MessengerBackfillScheduleInput,
  ): Promise<{ runId: string }> {
    assertValidRange(input)

    const integration = await messengerIntegrationService.findByIdForWorkspace({
      id: input.integrationId,
      workspaceId: input.workspaceId,
    })
    if (!integration) {
      throw new ChatbotXException(
        "Messenger Page not found in this workspace.",
        "messengerBackfillIntegrationNotFound",
        404,
      )
    }

    const run = await coexistSyncRunRepository.createBackfillRun(input)
    if (!run) {
      throw new ChatbotXException(
        "A Messenger backfill is already running for this Page.",
        "messengerBackfillAlreadyRunning",
        409,
      )
    }

    return { runId: run.id }
  }

  async retry(input: {
    workspaceId: string
    runId: string
    requestedByUserId: string | null
  }): Promise<{ runId: string }> {
    const previous = await coexistSyncRunRepository.findRunById({
      runId: input.runId,
    })
    if (
      !previous ||
      previous.workspaceId !== input.workspaceId ||
      previous.type !== "backfill" ||
      !["failed", "partial"].includes(previous.status) ||
      !previous.rangeFromAt ||
      !previous.rangeToAt ||
      previous.includeContacts === null ||
      previous.includeMessages === null
    ) {
      throw new ChatbotXException(
        "This Messenger backfill cannot be retried.",
        "messengerBackfillRetryInvalid",
        400,
      )
    }

    return this.schedule({
      workspaceId: input.workspaceId,
      integrationId: previous.integrationId,
      requestedByUserId: input.requestedByUserId,
      rangeFromAt: previous.rangeFromAt,
      rangeToAt: previous.rangeToAt,
      includeContacts: previous.includeContacts,
      includeMessages: previous.includeMessages,
      triggerSource: "manual-retry",
    })
  }

  async requestCancel(input: {
    workspaceId: string
    runId: string
  }): Promise<boolean> {
    return (await coexistSyncRunRepository.requestBackfillCancel(input)) > 0
  }

  getLatest(input: { workspaceId: string; integrationId: string }) {
    return coexistSyncRunRepository.findLatestBackfillRun(input)
  }

  listHistory(input: {
    workspaceId: string
    integrationId?: string
    page?: number
    perPage?: number
    sort?: { id: string; desc: boolean }[]
  }) {
    return coexistSyncRunRepository.listBackfillRuns(input)
  }

  pickDue(input: {
    batchSize: number
    maxAttempts: number
  }): Promise<PickedCoexistRun[]> {
    return coexistSyncRunRepository.pickDueRuns({
      ...input,
      type: "backfill",
    })
  }

  markMaxAttemptsFailed(input: { maxAttempts: number }): Promise<void> {
    return coexistSyncRunRepository.markMaxAttemptsFailed({
      ...input,
      type: "backfill",
    })
  }

  tearDownForIntegration(input: {
    workspaceId: string
    integrationId: string
    currentError: string
    tx?: DatabaseClient
  }): Promise<void> {
    return coexistSyncRunRepository.tearDownActiveBackfillsForIntegration(input)
  }

  claim(input: { runId: string }): Promise<CoexistSyncRunModel | null> {
    return coexistSyncRunRepository.claimBackfillRun(input)
  }

  yieldForContinuation(input: {
    runId: string
    expect: CoexistRunWriteGuard
  }): Promise<number> {
    return coexistSyncRunRepository.yieldBackfillForContinuation(input)
  }

  reopenReleased(input: { runId: string }): Promise<number> {
    return coexistSyncRunRepository.reopenReleasedBackfill(input)
  }

  updateProgress(input: CoexistRunProgressInput): Promise<number> {
    return coexistSyncRunRepository.updateProgress(input)
  }

  incrementProgress(input: {
    runId: string
    increments: IncrementProgressCounters
    fields?: CoexistRunProgressInput["fields"]
    expect: CoexistRunWriteGuard
  }): Promise<number> {
    return coexistSyncRunRepository.incrementProgress({
      runId: input.runId,
      increments: input.increments,
      fields: input.fields,
      expect: input.expect,
    })
  }

  finish(input: {
    runId: string
    status: BackfillTerminalStatus
    currentError?: string
    expect?: CoexistRunWriteGuard
  }): Promise<number> {
    if (input.status === "succeeded") {
      return coexistSyncRunRepository.markSucceeded(input)
    }
    if (input.status === "partial") {
      return coexistSyncRunRepository.markPartial(input)
    }
    return coexistSyncRunRepository.markFailed({
      ...input,
      currentError: input.currentError ?? "Messenger backfill failed",
    })
  }

  resetForRetry(input: {
    runId: string
    currentError: string
    expect: CoexistRunWriteGuard
  }): Promise<number> {
    return coexistSyncRunRepository.updateProgress({
      runId: input.runId,
      fields: {
        status: "init",
        currentError: input.currentError,
        lastHeartbeatAt: new Date(),
      },
      expect: input.expect,
    })
  }

  findRunById(input: { runId: string }) {
    return coexistSyncRunRepository.findRunById(input)
  }
}

export const messengerBackfillService = new MessengerBackfillService()
