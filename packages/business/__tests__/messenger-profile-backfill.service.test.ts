import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findIntegration: vi.fn(),
  getCredentialStatus: vi.fn(),
  create: vi.fn(),
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  messengerProfileBackfillRunRepository: {
    create: mocks.create,
    findById: vi.fn(),
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
      expect.objectContaining({ policy: "pancake" }),
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
})
