import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findStatus: vi.fn(),
  findEncryptedForBackend: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
  findIntegration: vi.fn(),
  encryptText: vi.fn(),
  decryptText: vi.fn(),
  verifyPageToken: vi.fn(),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  messengerPancakeCredentialRepository: {
    findStatus: mocks.findStatus,
    findEncryptedForBackend: mocks.findEncryptedForBackend,
    upsert: mocks.upsert,
    delete: mocks.delete,
  },
}))

vi.mock("@chatbotx.io/encryption", () => ({
  encryptUtils: {
    encryptText: mocks.encryptText,
    decryptText: mocks.decryptText,
  },
}))

vi.mock("../src/integration-messenger/service", () => ({
  messengerIntegrationService: {
    findByIdForWorkspace: mocks.findIntegration,
  },
}))

vi.mock("../src/messenger-pancake-credential/client", () => ({
  verifyPancakePageToken: mocks.verifyPageToken,
}))

const { messengerPancakeCredentialService } = await import(
  "../src/messenger-pancake-credential/service"
)

const REF = { workspaceId: "ws-1", integrationMessengerId: "im-1" }
const AAD = "messenger-pancake:ws-1:im-1"
const ENCRYPTED = {
  v: 1 as const,
  iv: "0".repeat(24),
  text: "ciphertext",
  tag: "0".repeat(32),
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findIntegration.mockResolvedValue({
    id: "im-1",
    workspaceId: "ws-1",
    pageId: "page-1",
  })
  mocks.verifyPageToken.mockResolvedValue(undefined)
  mocks.encryptText.mockResolvedValue(ENCRYPTED)
  mocks.upsert.mockResolvedValue({
    id: "pc-1",
    ...REF,
    verifiedAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    updatedByUserId: "user-1",
  })
})

describe("messengerPancakeCredentialService", () => {
  test("verifies the bound Page before encrypting and replacing the token", async () => {
    const result = await messengerPancakeCredentialService.verifyAndReplace({
      ...REF,
      token: "pancake-secret",
      updatedByUserId: "user-1",
    })

    expect(mocks.verifyPageToken).toHaveBeenCalledWith({
      pageId: "page-1",
      token: "pancake-secret",
    })
    expect(mocks.encryptText).toHaveBeenCalledWith("pancake-secret", AAD)
    expect(mocks.verifyPageToken.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.encryptText.mock.invocationCallOrder[0],
    )
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        ...REF,
        encryptedToken: ENCRYPTED,
        updatedByUserId: "user-1",
      }),
    )
    expect(result).toEqual(
      expect.objectContaining({
        configured: true,
        verifiedAt: expect.any(Date),
      }),
    )
    expect(result).not.toHaveProperty("encryptedToken")
    expect(JSON.stringify(result)).not.toContain("pancake-secret")
  })

  test("keeps the existing credential when verification fails", async () => {
    mocks.verifyPageToken.mockRejectedValue(new Error("invalid token"))

    await expect(
      messengerPancakeCredentialService.verifyAndReplace({
        ...REF,
        token: "bad-secret",
        updatedByUserId: "user-1",
      }),
    ).rejects.toThrow("invalid token")

    expect(mocks.encryptText).not.toHaveBeenCalled()
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  test("decrypts only inside the backend callback with Page-bound AAD", async () => {
    mocks.findEncryptedForBackend.mockResolvedValue({
      id: "pc-1",
      ...REF,
      encryptedToken: ENCRYPTED,
    })
    mocks.decryptText.mockResolvedValue("pancake-secret")
    const callback = vi.fn(async (token: string) => `used:${token.length}`)

    await expect(
      messengerPancakeCredentialService.withToken(REF, callback),
    ).resolves.toBe("used:14")

    expect(mocks.decryptText).toHaveBeenCalledWith(ENCRYPTED, AAD)
    expect(callback).toHaveBeenCalledWith("pancake-secret")
  })

  test("returns public configured state without loading ciphertext", async () => {
    mocks.findStatus.mockResolvedValue(null)

    await expect(
      messengerPancakeCredentialService.getStatus(REF),
    ).resolves.toEqual({ configured: false })

    expect(mocks.findEncryptedForBackend).not.toHaveBeenCalled()
  })
})
