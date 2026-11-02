import { describe, expect, test } from "vitest"
import { messengerMessagingEventSchema } from "../src/schema"

const eventWithTimestamp = (timestamp: number) => ({
  sender: { id: "psid-1" },
  recipient: { id: "page-1" },
  timestamp,
  message: { mid: "mid-1", text: "hello" },
})

describe("Messenger webhook timestamps", () => {
  test("accepts a current positive millisecond timestamp", () => {
    expect(
      messengerMessagingEventSchema.safeParse(eventWithTimestamp(Date.now()))
        .success,
    ).toBe(true)
  })

  test.each([
    0,
    -1,
    Number.POSITIVE_INFINITY,
  ])("rejects an invalid timestamp: %s", (timestamp) => {
    expect(
      messengerMessagingEventSchema.safeParse(eventWithTimestamp(timestamp))
        .success,
    ).toBe(false)
  })

  test("rejects a timestamp beyond the allowed future clock skew", () => {
    const oneHourFromNow = Date.now() + 60 * 60 * 1000

    expect(
      messengerMessagingEventSchema.safeParse(
        eventWithTimestamp(oneHourFromNow),
      ).success,
    ).toBe(false)
  })
})
