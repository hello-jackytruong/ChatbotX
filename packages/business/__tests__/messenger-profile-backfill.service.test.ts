import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findIntegration: vi.fn(),
  getCredentialStatus: vi.fn(),
  create: vi.fn(),
  findById: vi.fn(),
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  messengerProfileBackfillRunRepository: {
    create: mocks.create,
    findById: mocks.findById,
    listHistory: vi.fn(),
    claim: vi.fn(),
    requestCancel: vi.fn(),
    finish: vi.fn(),
  },
}))
vi.mock("../src/integration-messenger/service", () => ({
  messengerIntegrationService: { findByIdForWorkspace: mocks.findIntegration },
}))
vi.mock("../src/messenger-pancake-credential/service", () => ({
  messengerPancakeCredentialService: { getStatus: mocks.getCredentialStatus },
}))

const { messengerProfileBackfillService } = await import(
  "../src/messenger-profile-backfill/service"
)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findIntegration.mockResolvedValue({ id: "im-1", workspaceId: "ws-1" })
  mocks.getCredentialStatus.mockResolvedValue({ configured: true })
  mocks.create.mockResolvedValue({ id: "run-1" })
})

describe("messengerProfileBackfillService", () => {
  test("defaults to Pancake and requires its Page credential", async () => {
    await expect(
      messengerProfileBackfillService.schedule({
        workspaceId: "ws-1",
        integrationMessengerId: "im-1",
        requestedByUserId: "user-1",
      }),
    ).resolves.toEqual({ runId: "run-1" })
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: "pancake",
        overwriteExisting: false,
      }),
    )

    mocks.getCredentialStatus.mockResolvedValue({ configured: false })
    await expect(
      messengerProfileBackfillService.schedule({
        workspaceId: "ws-1",
        integrationMessengerId: "im-1",
        requestedByUserId: "user-1",
      }),
    ).rejects.toThrow("Configure the Pancake token")
  })

  test("allows explicit Meta without reading Pancake credentials", async () => {
    await messengerProfileBackfillService.schedule({
      workspaceId: "ws-1",
      integrationMessengerId: "im-1",
      requestedByUserId: "user-1",
      policy: "meta",
    })
    expect(mocks.getCredentialStatus).not.toHaveBeenCalled()
  })

  test("stores overwrite mode and preserves it when retrying", async () => {
    await messengerProfileBackfillService.schedule({
      workspaceId: "ws-1",
      integrationMessengerId: "im-1",
      requestedByUserId: "user-1",
      overwriteExisting: true,
    })
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ overwriteExisting: true }),
    )

    mocks.findById.mockResolvedValue({
      integrationMessengerId: "im-1",
      policy: "pancakeThenMeta",
      overwriteExisting: true,
      status: "failed",
    })
    await messengerProfileBackfillService.retry({
      workspaceId: "ws-1",
      runId: "run-old",
      requestedByUserId: "user-1",
    })
    expect(mocks.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        policy: "pancakeThenMeta",
        overwriteExisting: true,
      }),
    )
  })
})
