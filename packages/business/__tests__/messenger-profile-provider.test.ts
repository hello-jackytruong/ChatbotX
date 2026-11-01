import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({ withToken: vi.fn(), fetchPancake: vi.fn() }))
vi.mock("../src/messenger-pancake-credential/service", () => ({
  messengerPancakeCredentialService: { withToken: mocks.withToken },
}))
vi.mock("../src/messenger-profile-provider/client", async (original) => ({
  ...(await original()),
  fetchPancakeMessengerProfile: mocks.fetchPancake,
}))

const { resolveMessengerProfile } = await import(
  "../src/messenger-profile-provider/service"
)
const { mapPancakeConversationProfile } = await import(
  "../src/messenger-profile-provider/client"
)

beforeEach(() => vi.clearAllMocks())

describe("Messenger profile provider", () => {
  test("accepts one exact conv_from PSID and maps safe fields", () => {
    expect(
      mapPancakeConversationProfile({
        pageId: "page-1",
        psid: "psid-1",
        payload: {
          data: [
            {
              page_id: "page-1",
              conv_from: {
                id: "psid-1",
                name: "Ada Lovelace",
                gender: "female",
              },
            },
          ],
        },
      }),
    ).toMatchObject({
      sourceId: "psid-1",
      firstName: "Ada",
      lastName: "Lovelace",
      gender: "female",
      provider: "pancake",
    })
  })

  test("rejects page/PSID mismatch and ambiguous records", () => {
    const payload = {
      data: [
        { page_id: "page-2", conv_from: { id: "psid-1", name: "Wrong" } },
        { page_id: "page-1", conv_from: { id: "other", name: "Wrong" } },
      ],
    }
    expect(
      mapPancakeConversationProfile({
        pageId: "page-1",
        psid: "psid-1",
        payload,
      }),
    ).toBeNull()
  })

  test("Pancake success skips Meta; missing data falls back safely", async () => {
    const meta = vi
      .fn()
      .mockResolvedValue({ sourceId: "psid-1", firstName: "Meta" })
    mocks.withToken.mockImplementation(async (_ref, use) => use("secret"))
    mocks.fetchPancake.mockResolvedValue({
      sourceId: "psid-1",
      firstName: "Pancake",
      provider: "pancake",
    })
    await expect(
      resolveMessengerProfile({
        workspaceId: "ws-1",
        integrationMessengerId: "im-1",
        pageId: "page-1",
        sourceId: "psid-1",
        getMetaProfile: meta,
      }),
    ).resolves.toMatchObject({ firstName: "Pancake" })
    expect(meta).not.toHaveBeenCalled()

    mocks.fetchPancake.mockResolvedValue(null)
    await expect(
      resolveMessengerProfile({
        workspaceId: "ws-1",
        integrationMessengerId: "im-1",
        pageId: "page-1",
        sourceId: "psid-1",
        getMetaProfile: meta,
      }),
    ).resolves.toMatchObject({ firstName: "Meta", provider: "meta" })
  })
})
