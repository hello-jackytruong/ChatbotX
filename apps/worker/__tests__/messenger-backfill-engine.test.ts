import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  advanceCheckpoint: vi.fn(),
  applyActivity: vi.fn(),
  bulkImportContacts: vi.fn(),
  bulkImportMessages: vi.fn(),
  claim: vi.fn(),
  enqueueAttachments: vi.fn(),
  findInbox: vi.fn(),
  findIntegration: vi.fn(),
  findRun: vi.fn(),
  findWorkspace: vi.fn(),
  finish: vi.fn(),
  incrementProgress: vi.fn(),
  listConversations: vi.fn(),
  resetForRetry: vi.fn(),
  walkRange: vi.fn(),
  yieldForContinuation: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  bulkImportChannelContacts: mocks.bulkImportContacts,
  inboxService: { find: mocks.findInbox },
  messengerBackfillService: {
    claim: mocks.claim,
    findRunById: mocks.findRun,
    finish: mocks.finish,
    incrementProgress: mocks.incrementProgress,
    reopenReleased: vi.fn(),
    resetForRetry: mocks.resetForRetry,
    yieldForContinuation: mocks.yieldForContinuation,
  },
  messengerIntegrationService: {
    advanceAutoBackfillCheckpoint: mocks.advanceCheckpoint,
    findByIdForWorkspace: mocks.findIntegration,
  },
  workspaceService: { find: mocks.findWorkspace },
}))

vi.mock("@chatbotx.io/integration-messenger/apis/sync", () => ({
  listConversations: mocks.listConversations,
}))

vi.mock("@chatbotx.io/integration-messenger/apis/usage", () => ({
  concurrencyForUsage: () => 1,
}))

vi.mock("@chatbotx.io/redis", () => ({
  distributedLock: {
    runExclusive: ({ fn }: { fn: () => Promise<void> }) => fn(),
  },
}))

vi.mock("@chatbotx.io/worker-config", () => ({
  buildMessengerBackfillPageJobId: () => "continuation",
  IntegrationJobAction: { messengerBackfill: "messengerBackfill" },
  integrationQueue: { add: vi.fn() },
}))

vi.mock("../src/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))

vi.mock("../src/integration/handlers/coexist/bulk-historical-import", () => ({
  applyCoexistActivityUpdates: mocks.applyActivity,
  bulkImportMessages: mocks.bulkImportMessages,
  createHistoricalIdFactory: () => vi.fn(),
  maxNumericId: (_current: string | null, candidate: string | null) =>
    candidate,
}))

vi.mock(
  "../src/integration/handlers/coexist/enqueue-attachment-downloads",
  () => ({
    enqueueAttachmentDownloadJobs: mocks.enqueueAttachments,
  }),
)

vi.mock("../src/integration/handlers/coexist/messenger-helpers", () => ({
  messengerAuthSchema: {
    safeParse: () => ({
      success: true,
      data: { tokens: { accessToken: "token" }, metadata: {} },
    }),
  },
  splitName: (name: string) => ({ firstName: name }),
  withInlineRetry: (fn: () => Promise<unknown>) => fn(),
}))

vi.mock("../src/integration/handlers/profile-snapshot/queue", () => ({
  enqueueProfileSnapshotJobs: vi.fn(),
}))

vi.mock(
  "../src/integration/handlers/messenger-backfill/message-walker",
  () => ({ walkMessengerConversationRange: mocks.walkRange }),
)

const { runMessengerBackfill } = await import(
  "../src/integration/handlers/messenger-backfill/engine"
)

const run = {
  id: "run-1",
  type: "backfill",
  status: "running",
  claimToken: "claim-1",
  workspaceId: "workspace-1",
  integrationId: "integration-1",
  attempts: 1,
  currentPageNumber: 0,
  resumeCursor: null,
  rangeFromAt: new Date("2026-01-01T00:00:00Z"),
  rangeToAt: new Date("2026-01-02T00:00:00Z"),
  includeContacts: true,
  includeMessages: true,
  triggerSource: "auto",
  cancelRequestedAt: null,
  failedCount: 0,
  currentError: null,
}

const conversation = (id: string) => ({
  id,
  updated_time: "2026-01-01T12:00:00Z",
  participants: { data: [{ id: `person-${id}`, name: "Person" }] },
})

describe("Messenger backfill engine regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findRun.mockResolvedValue(run)
    mocks.claim.mockResolvedValue(run)
    mocks.findIntegration.mockResolvedValue({
      pageId: "page-1",
      inboxId: "inbox-1",
      auth: {},
    })
    mocks.findInbox.mockResolvedValue({ id: "inbox-1" })
    mocks.findWorkspace.mockResolvedValue({ targetCountry: "VN" })
    mocks.finish.mockResolvedValue(1)
    mocks.incrementProgress.mockResolvedValue(1)
    mocks.yieldForContinuation.mockResolvedValue(1)
    mocks.advanceCheckpoint.mockResolvedValue(undefined)
    mocks.applyActivity.mockResolvedValue(undefined)
    mocks.enqueueAttachments.mockResolvedValue(undefined)
  })

  test("treats a page-level unavailable response as successful and checkpoints auto", async () => {
    mocks.listConversations.mockRejectedValue({ code: 100, subCode: 33 })

    await runMessengerBackfill({ runId: run.id, workspaceId: run.workspaceId })

    expect(mocks.incrementProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        increments: expect.objectContaining({ skippedUnavailableCount: 1 }),
      }),
    )
    expect(mocks.finish).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded" }),
    )
    expect(mocks.advanceCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ checkpoint: run.rangeToAt }),
    )
  })

  test("persists committed page counters before a later conversation fails", async () => {
    mocks.listConversations.mockResolvedValue({
      data: [conversation("first"), conversation("second")],
    })
    mocks.bulkImportContacts.mockResolvedValue({
      failureReason: null,
      importedContacts: 1,
      skippedContacts: 0,
      contactInboxIds: new Map([
        [
          "person-first",
          {
            contactInboxId: "contact-inbox-1",
            contactId: "contact-1",
            conversationId: "local-conversation-1",
          },
        ],
      ]),
      newContactInboxIds: new Map(),
    })
    mocks.bulkImportMessages.mockResolvedValue({
      importedMessages: 2,
      skippedMessages: 0,
      insertedAttachmentIds: [],
      newestMessageAt: new Date("2026-01-01T12:00:00Z"),
      oldestMessageAt: new Date("2026-01-01T11:00:00Z"),
      newestIncomingMessageAt: null,
      newestMessageId: "2",
    })
    mocks.walkRange
      .mockImplementationOnce(async ({ onPage }) => {
        await onPage({
          messages: [{ sourceId: "1" }, { sourceId: "2" }],
          discovered: {},
          hasInRange: true,
        })
        return { hadInRange: true, discovered: {}, status: "completed" }
      })
      .mockRejectedValueOnce({ code: 190, type: "OAuthException" })

    await runMessengerBackfill({ runId: run.id, workspaceId: run.workspaceId })

    expect(mocks.incrementProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        increments: expect.objectContaining({ importedMessageCount: 2 }),
      }),
    )
    expect(mocks.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        currentError: expect.stringContaining("Reconnect"),
      }),
    )
  })

  test("keeps the active conversation message cursor when a chunk yields", async () => {
    mocks.listConversations.mockResolvedValue({
      data: [conversation("large")],
      after: "outer-page-2",
    })
    mocks.bulkImportContacts.mockResolvedValue({
      failureReason: null,
      importedContacts: 1,
      skippedContacts: 0,
      contactInboxIds: new Map([
        [
          "person-large",
          {
            contactInboxId: "contact-inbox-1",
            contactId: "contact-1",
            conversationId: "local-conversation-1",
          },
        ],
      ]),
      newContactInboxIds: new Map(),
    })
    mocks.bulkImportMessages.mockResolvedValue({
      importedMessages: 1,
      skippedMessages: 0,
      insertedAttachmentIds: [],
      newestMessageAt: new Date("2026-01-01T12:00:00Z"),
      oldestMessageAt: new Date("2026-01-01T12:00:00Z"),
      newestIncomingMessageAt: null,
      newestMessageId: "1",
    })
    mocks.walkRange.mockImplementationOnce(async ({ onPage }) => {
      await onPage({
        messages: [{ sourceId: "1" }],
        discovered: {},
        hasInRange: true,
        nextCursor: "message-page-2",
      })
      return { hadInRange: true, discovered: {}, status: "yielded" }
    })

    await runMessengerBackfill({ runId: run.id, workspaceId: run.workspaceId })

    const progressCalls = mocks.incrementProgress.mock.calls.map(
      ([input]) => input,
    )
    expect(
      progressCalls.some((input) =>
        String(input.fields?.resumeCursor).includes(
          '"messageCursor":"message-page-2"',
        ),
      ),
    ).toBe(true)
    expect(progressCalls.at(-1)?.fields?.resumeCursor).toBeUndefined()
    expect(mocks.yieldForContinuation).toHaveBeenCalledOnce()
  })

  test("retries the same page when attachment enqueue fails before cursor commit", async () => {
    mocks.listConversations.mockResolvedValue({
      data: [conversation("repair")],
    })
    mocks.bulkImportContacts.mockResolvedValue({
      failureReason: null,
      importedContacts: 1,
      skippedContacts: 0,
      contactInboxIds: new Map([
        [
          "person-repair",
          {
            contactInboxId: "contact-inbox-1",
            contactId: "contact-1",
            conversationId: "local-conversation-1",
          },
        ],
      ]),
      newContactInboxIds: new Map(),
    })
    mocks.bulkImportMessages.mockResolvedValue({
      importedMessages: 1,
      skippedMessages: 0,
      insertedAttachmentIds: ["attachment-1"],
      newestMessageAt: new Date("2026-01-01T12:00:00Z"),
      oldestMessageAt: new Date("2026-01-01T12:00:00Z"),
      newestIncomingMessageAt: null,
      newestMessageId: "1",
    })
    mocks.enqueueAttachments.mockRejectedValueOnce(new Error("Redis down"))
    mocks.walkRange.mockImplementationOnce(async ({ onPage }) => {
      await onPage({
        messages: [{ sourceId: "1" }],
        discovered: {},
        hasInRange: true,
        nextCursor: "must-not-commit",
      })
      return { hadInRange: true, discovered: {}, status: "completed" }
    })

    await runMessengerBackfill({ runId: run.id, workspaceId: run.workspaceId })

    expect(mocks.resetForRetry).toHaveBeenCalledWith(
      expect.objectContaining({ runId: run.id }),
    )
    expect(
      mocks.incrementProgress.mock.calls.some(([input]) =>
        String(input.fields?.resumeCursor).includes("must-not-commit"),
      ),
    ).toBe(false)
  })
})
