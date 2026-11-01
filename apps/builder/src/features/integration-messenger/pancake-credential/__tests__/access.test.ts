import { describe, expect, test, vi } from "vitest"

vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}))

const { assertCanManagePancakeCredential } = await import(
  "../lib/assert-can-manage"
)

describe("assertCanManagePancakeCredential", () => {
  test("allows a real workspace super admin", async () => {
    await expect(
      assertCanManagePancakeCredential({
        workspaceMemberPermissions: { superAdmin: true },
        isSupportSession: false,
      }),
    ).resolves.toBeUndefined()
  })

  test("rejects a member without superAdmin permission", async () => {
    await expect(
      assertCanManagePancakeCredential({
        workspaceMemberPermissions: {},
        isSupportSession: false,
      }),
    ).rejects.toThrow("errors.superAdminRequired")
  })

  test("rejects a synthetic platform support session", async () => {
    await expect(
      assertCanManagePancakeCredential({
        workspaceMemberPermissions: { superAdmin: true },
        isSupportSession: true,
      }),
    ).rejects.toThrow("messengerPancakeCredential.errors.supportSession")
  })
})
