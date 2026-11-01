import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findByIdForWorkspace: vi.fn(),
  createBackfillRun: vi.fn(),
  findLatestBackfillRun: vi.fn(),
  listBackfillRuns: vi.fn(),
  requestBackfillCancel: vi.fn(),
  claimBackfillRun: vi.fn(),
  yieldBackfillForContinuation: vi.fn(),
  reopenReleasedBackfill: vi.fn(),
  updateProgress: vi.fn(),
  incrementProgress: vi.fn(),
  markSucceeded: vi.fn(),
  markPartial: vi.fn(),
  markFailed: vi.fn(),
  findRunById: vi.fn(),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  coexistSyncRunRepository: {
    createBackfillRun: mocks.createBackfillRun,
    findLatestBackfillRun: mocks.findLatestBackfillRun,
    listBackfillRuns: mocks.listBackfillRuns,
    requestBackfillCancel: mocks.requestBackfillCancel,
    claimBackfillRun: mocks.claimBackfillRun,
    yieldBackfillForContinuation: mocks.yieldBackfillForContinuation,
    reopenReleasedBackfill: mocks.reopenReleasedBackfill,
    updateProgress: mocks.updateProgress,
    incrementProgress: mocks.incrementProgress,
    markSucceeded: mocks.markSucceeded,
    markPartial: mocks.markPartial,
    markFailed: mocks.markFailed,
    findRunById: mocks.findRunById,
  },
}))

vi.mock("../src/integration-messenger/service", () => ({
  messengerIntegrationService: {
    findByIdForWorkspace: mocks.findByIdForWorkspace,
  },
}))

const { messengerBackfillService } = await import(
  "../src/messenger-backfill/service"
)

const workspaceId = "workspace-1"
const integrationId = "integration-1"
const requestedByUserId = "user-1"
const rangeFromAt = new Date("2023-01-01T00:00:00.000Z")
const rangeToAt = new Date("2026-01-01T00:00:00.000Z")

describe("messengerBackfillService.schedule", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findByIdForWorkspace.mockResolvedValue({ id: integrationId })
    mocks.createBackfillRun.mockResolvedValue({ id: "run-1" })
  })

  test("creates an exact-range manual Messenger run without a lookback cap", async () => {
    await expect(
      messengerBackfillService.schedule({
        workspaceId,
        integrationId,
        requestedByUserId,
        rangeFromAt,
        rangeToAt,
        includeContacts: true,
        includeMessages: true,
        triggerSource: "manual",
      }),
    ).resolves.toEqual({ runId: "run-1" })

    expect(mocks.createBackfillRun).toHaveBeenCalledWith({
      workspaceId,
      integrationId,
      requestedByUserId,
      rangeFromAt,
      rangeToAt,
      includeContacts: true,
      includeMessages: true,
      triggerSource: "manual",
    })
  })

  test.each([
    {
      name: "an inverted range",
      input: { rangeFromAt: rangeToAt, rangeToAt: rangeFromAt },
      code: "messengerBackfillRangeInvalid",
    },
    {
      name: "a future upper bound",
      input: {
        rangeFromAt,
        rangeToAt: new Date(Date.now() + 60_000),
      },
      code: "messengerBackfillRangeInvalid",
    },
  ])("rejects $name", async ({ input, code }) => {
    await expect(
      messengerBackfillService.schedule({
        workspaceId,
        integrationId,
        requestedByUserId,
        ...input,
        includeContacts: true,
        includeMessages: true,
        triggerSource: "manual",
      }),
    ).rejects.toMatchObject({ code, httpStatusCode: 400 })
    expect(mocks.findByIdForWorkspace).not.toHaveBeenCalled()
  })

  test("requires Contacts, Messages, or both", async () => {
    await expect(
      messengerBackfillService.schedule({
        workspaceId,
        integrationId,
        requestedByUserId,
        rangeFromAt,
        rangeToAt,
        includeContacts: false,
        includeMessages: false,
        triggerSource: "manual",
      }),
    ).rejects.toMatchObject({
      code: "messengerBackfillResourcesRequired",
      httpStatusCode: 400,
    })
  })

  test("workspace-scopes the selected Messenger Page", async () => {
    mocks.findByIdForWorkspace.mockResolvedValue(undefined)

    await expect(
      messengerBackfillService.schedule({
        workspaceId,
        integrationId,
        requestedByUserId,
        rangeFromAt,
        rangeToAt,
        includeContacts: true,
        includeMessages: false,
        triggerSource: "manual",
      }),
    ).rejects.toMatchObject({
      code: "messengerBackfillIntegrationNotFound",
      httpStatusCode: 404,
    })
  })

  test("maps a concurrent active-run race to a stable conflict", async () => {
    mocks.createBackfillRun.mockResolvedValue(null)

    await expect(
      messengerBackfillService.schedule({
        workspaceId,
        integrationId,
        requestedByUserId,
        rangeFromAt,
        rangeToAt,
        includeContacts: true,
        includeMessages: false,
        triggerSource: "manual",
      }),
    ).rejects.toMatchObject({
      code: "messengerBackfillAlreadyRunning",
      httpStatusCode: 409,
    })
  })
})

describe("messengerBackfillService lifecycle", () => {
  beforeEach(() => vi.clearAllMocks())

  test("cancel remains workspace- and type-scoped in the repository", async () => {
    mocks.requestBackfillCancel.mockResolvedValue(1)
    await expect(
      messengerBackfillService.requestCancel({ workspaceId, runId: "run-1" }),
    ).resolves.toBe(true)
    expect(mocks.requestBackfillCancel).toHaveBeenCalledWith({
      workspaceId,
      runId: "run-1",
    })
  })

  test("retry clones only a failed or partial workspace run", async () => {
    mocks.findRunById.mockResolvedValue({
      id: "run-old",
      workspaceId,
      integrationId,
      type: "backfill",
      status: "partial",
      rangeFromAt,
      rangeToAt,
      includeContacts: false,
      includeMessages: true,
    })
    mocks.findByIdForWorkspace.mockResolvedValue({ id: integrationId })
    mocks.createBackfillRun.mockResolvedValue({ id: "run-new" })

    await expect(
      messengerBackfillService.retry({
        workspaceId,
        runId: "run-old",
        requestedByUserId,
      }),
    ).resolves.toEqual({ runId: "run-new" })

    expect(mocks.createBackfillRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        integrationId,
        rangeFromAt,
        rangeToAt,
        includeContacts: false,
        includeMessages: true,
        triggerSource: "manual-retry",
      }),
    )
  })
})
