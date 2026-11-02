import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({ withToken: vi.fn(), fetchPancake: vi.fn() }))
vi.mock("../src/messenger-pancake-credential/service", () => ({
  messengerPancakeCredentialService: { withToken: mocks.withToken },
}))
vi.mock("../src/messenger-profile-provider/client", async (original) => ({
  ...(await original()),
  fetchPancakeMessengerProfile: mocks.fetchPancake,
}))

const { resolveIndexedMessengerProfile, resolveMessengerProfile } =
  await import("../src/messenger-profile-provider/service")
const {
  fetchPancakeMessengerProfiles,
  mapPancakeConversationProfile,
  mapPancakeConversationProfiles,
} = await import("../src/messenger-profile-provider/client")

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

const conversation = (input: {
  pageId?: string
  psid: string
  name?: string
  gender?: string | null
  updatedAt?: string
  fromId?: string
}) => ({
  id: `${input.pageId ?? "page-1"}_${input.psid}`,
  page_id: input.pageId ?? "page-1",
  customer_id: `internal-${input.psid}`,
  updated_at: input.updatedAt ?? "2026-11-01T12:23:24.831000",
  from: {
    id: input.fromId ?? input.psid,
    name: input.name ?? "Tươi Thị Lê",
  },
  customers: [
    {
      id: `page-customer-${input.psid}`,
      fb_id: input.psid,
      name: input.name ?? "Tươi Thị Lê",
    },
  ],
  page_customer: {
    id: `page-customer-${input.psid}`,
    customer_id: `internal-${input.psid}`,
    psid: input.psid,
    name: input.name ?? "Tươi Thị Lê",
    gender: input.gender ?? "female",
  },
})

describe("Messenger profile provider", () => {
  test("maps the real conversations contract and deduplicates equal identities", () => {
    expect(
      mapPancakeConversationProfile({
        pageId: "page-1",
        psid: "psid-1",
        payload: {
          success: true,
          conversations: [
            conversation({ psid: "psid-1", name: "Ada Lovelace" }),
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

    expect(
      mapPancakeConversationProfiles({
        pageId: "page-1",
        payload: {
          conversations: [
            {
              page_id: "page-1",
              customers: [{ fb_id: "psid-2", name: "Grace Hopper" }],
            },
          ],
        },
      }),
    ).toEqual([
      expect.objectContaining({ firstName: "Grace", lastName: "Hopper" }),
    ])
  })

  test("rejects Page mismatch and conflicting conversation identities", () => {
    expect(
      mapPancakeConversationProfile({
        pageId: "page-1",
        psid: "psid-1",
        payload: {
          conversations: [
            conversation({ pageId: "page-2", psid: "psid-1" }),
            conversation({ psid: "psid-1", fromId: "other-psid" }),
          ],
        },
      }),
    ).toBeNull()

    const missingPage = conversation({ psid: "psid-1" })
    ;(missingPage as { page_id?: string }).page_id = undefined
    expect(
      mapPancakeConversationProfile({
        pageId: "page-1",
        psid: "psid-1",
        payload: { conversations: [missingPage] },
      }),
    ).toBeNull()

    expect(
      mapPancakeConversationProfile({
        pageId: "page-1",
        psid: "psid-1",
        payload: {
          conversations: [
            {
              page_id: "page-1",
              from: { id: "psid-1" },
              page_customer: { psid: "psid-1" },
              customers: [{ id: "internal-id", name: "Unbound Name" }],
            },
          ],
        },
      }),
    ).toBeNull()
  })

  test("uses the newest conversation when a PSID appears more than once", () => {
    expect(
      mapPancakeConversationProfile({
        pageId: "page-1",
        psid: "psid-1",
        payload: {
          conversations: [
            conversation({
              psid: "psid-1",
              name: "Old Name",
              updatedAt: "2026-10-01T00:00:00Z",
            }),
            conversation({
              psid: "psid-1",
              name: "New Name",
              updatedAt: "2026-11-01T00:00:00Z",
            }),
          ],
        },
      }),
    ).toMatchObject({ firstName: "New", lastName: "Name" })
  })

  test("paginates conversations without unsupported customer filters", async () => {
    const firstPage = Array.from({ length: 60 }, (_, index) =>
      conversation({ psid: `psid-${index}` }),
    )
    const secondPage = [conversation({ psid: "psid-60" })]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: true, conversations: firstPage }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: true, conversations: secondPage }),
          { status: 200 },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)

    const profiles = await fetchPancakeMessengerProfiles({
      pageId: "page-1",
      token: "secret",
      includeAvatar: true,
    })

    expect(profiles).toHaveLength(61)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstUrl = new URL(String(fetchMock.mock.calls[0]?.[0]))
    const secondUrl = new URL(String(fetchMock.mock.calls[1]?.[0]))
    expect(firstUrl.searchParams.has("customer_id")).toBe(false)
    expect(firstUrl.searchParams.has("page_size")).toBe(false)
    expect(firstUrl.searchParams.get("fields")).toContain("page_customer")
    expect(secondUrl.searchParams.get("last_conversation_id")).toBe(
      firstPage.at(-1)?.id,
    )
  })

  test("rejects a malformed successful conversations payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            conversations: { unexpected: [] },
          }),
          { status: 200 },
        ),
      ),
    )

    await expect(
      fetchPancakeMessengerProfiles({
        pageId: "page-1",
        token: "secret",
      }),
    ).rejects.toThrow("Pancake conversations could not be read")
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

  test("backfill resolves from its Page index and calls Meta only for misses", async () => {
    const pancakeProfile = {
      sourceId: "psid-1",
      firstName: "Pancake",
      provider: "pancake" as const,
    }
    const meta = vi
      .fn()
      .mockResolvedValue({ sourceId: "psid-2", firstName: "Meta" })
    const pancakeProfiles = new Map([["psid-1", pancakeProfile]])

    await expect(
      resolveIndexedMessengerProfile({
        sourceId: "psid-1",
        policy: "pancakeThenMeta",
        pancakeProfiles,
        getMetaProfile: meta,
      }),
    ).resolves.toEqual(pancakeProfile)
    expect(meta).not.toHaveBeenCalled()

    await expect(
      resolveIndexedMessengerProfile({
        sourceId: "psid-2",
        policy: "pancakeThenMeta",
        pancakeProfiles,
        getMetaProfile: meta,
      }),
    ).resolves.toMatchObject({ firstName: "Meta", provider: "meta" })
    expect(meta).toHaveBeenCalledTimes(1)
  })
})
