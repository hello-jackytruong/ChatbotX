import { beforeEach, describe, expect, test, vi } from "vitest"

const listMessages = vi.hoisted(() => vi.fn())

vi.mock("@chatbotx.io/integration-messenger/apis/sync", () => ({
  listMessages,
}))

vi.mock("../src/env", () => ({
  env: { MESSENGER_HISTORY_LOOKBACK_DAYS: 90 },
}))

const { walkMessengerConversationRange } = await import(
  "../src/integration/handlers/messenger-backfill/message-walker"
)

const baseInput = {
  conversationId: "conv-1",
  accessToken: "token",
  pageId: "page-1",
  defaultCountry: "VN",
  range: {
    fromAt: new Date("2023-01-01T00:00:00.000Z"),
    toAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  applyBucThrottle: vi.fn(),
  respectPause: vi.fn(),
}

describe("walkMessengerConversationRange", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test("flushes only inclusive in-range messages and stops at the older boundary", async () => {
    listMessages.mockResolvedValue({
      data: [
        { id: "new", message: "new", created_time: "2026-01-02T00:00:00Z" },
        { id: "to", message: "to", created_time: "2026-01-01T00:00:00Z" },
        { id: "from", message: "from", created_time: "2023-01-01T00:00:00Z" },
        { id: "old", message: "old", created_time: "2022-12-31T23:59:59Z" },
        { id: "older", message: "older", created_time: "2020-01-01T00:00:00Z" },
      ],
      after: "must-not-fetch",
    })
    const seen: string[] = []

    const result = await walkMessengerConversationRange({
      ...baseInput,
      includeMessages: true,
      onPage: ({ messages }) => {
        seen.push(...messages.map((message) => message.sourceId))
        return Promise.resolve()
      },
    })

    expect(seen).toEqual(["to", "from"])
    expect(result.hadInRange).toBe(true)
    expect(listMessages).toHaveBeenCalledOnce()
  })

  test("contacts-only proves activity but never sends messages to storage", async () => {
    listMessages.mockResolvedValue({
      data: [
        {
          id: "in-range",
          message: "Email me at customer@example.com",
          created_time: "2024-01-01T00:00:00Z",
        },
      ],
    })
    const pages: unknown[] = []

    const result = await walkMessengerConversationRange({
      ...baseInput,
      includeMessages: false,
      onPage: async (page) => pages.push(page),
    })

    expect(result.hadInRange).toBe(true)
    expect(result.discovered.email).toBe("customer@example.com")
    expect(pages).toEqual([
      expect.objectContaining({ messages: [], hasInRange: true }),
    ])
  })

  test("retries the same cursor with a smaller limit on oversized responses", async () => {
    listMessages
      .mockRejectedValueOnce({
        code: 1,
        message: "Please reduce the amount of data you're asking for",
      })
      .mockResolvedValueOnce({ data: [] })

    await walkMessengerConversationRange({
      ...baseInput,
      includeMessages: true,
      onPage: vi.fn(),
    })

    expect(listMessages.mock.calls[0][0].limit).toBe(499)
    expect(listMessages.mock.calls[1][0].limit).toBe(249)
    expect(listMessages.mock.calls[1][0].after).toBeUndefined()
  })

  test("retries an unknown provider failure three times before surfacing it", async () => {
    vi.useFakeTimers()
    const providerError = new Error("Graph returned an unknown failure")
    listMessages.mockRejectedValue(providerError)

    const pending = walkMessengerConversationRange({
      ...baseInput,
      includeMessages: true,
      onPage: vi.fn(),
    })
    const rejected = expect(pending).rejects.toBe(providerError)
    await vi.runAllTimersAsync()

    await rejected
    expect(listMessages).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })

  test("yields between message pages and resumes after the committed page", async () => {
    listMessages.mockImplementation(({ after }: { after?: string }) =>
      Promise.resolve(
        after
          ? {
              data: [
                {
                  id: "second",
                  message: "second",
                  created_time: "2024-01-01T00:00:00Z",
                },
              ],
            }
          : {
              data: [
                {
                  id: "first",
                  message: "first",
                  created_time: "2024-01-02T00:00:00Z",
                },
              ],
              after: "page-2",
            },
      ),
    )
    const stored = new Set<string>()
    let resumeCursor: string | undefined
    const onPage = ({
      messages,
      nextCursor,
    }: {
      messages: Array<{ sourceId: string }>
      nextCursor?: string
    }) => {
      for (const message of messages) {
        stored.add(message.sourceId)
      }
      resumeCursor = nextCursor
      return Promise.resolve()
    }

    const getInterruption = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue("yielded")
    const firstChunk = await walkMessengerConversationRange({
      ...baseInput,
      includeMessages: true,
      getInterruption,
      onPage,
    })
    expect(firstChunk.status).toBe("yielded")
    expect(listMessages).toHaveBeenCalledTimes(1)

    const resumed = await walkMessengerConversationRange({
      ...baseInput,
      includeMessages: true,
      initialCursor: resumeCursor,
      onPage,
    })
    expect(resumed.status).toBe("completed")
    expect(stored).toEqual(new Set(["first", "second"]))
    expect(listMessages.mock.calls[1][0].after).toBe("page-2")
  })

  test("observes cancellation before starting another provider request", async () => {
    listMessages.mockResolvedValue({
      data: [
        {
          id: "first",
          message: "first",
          created_time: "2024-01-02T00:00:00Z",
        },
      ],
      after: "page-2",
    })

    const result = await walkMessengerConversationRange({
      ...baseInput,
      includeMessages: true,
      getInterruption: () => Promise.resolve("cancelled"),
      onPage: vi.fn().mockResolvedValue(undefined),
    })

    expect(result.status).toBe("cancelled")
    expect(listMessages).not.toHaveBeenCalled()
  })
})
