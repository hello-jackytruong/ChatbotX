import { describe, expect, test } from "vitest"
import {
  classifyMessageTimestamp,
  shouldStopConversationWalk,
} from "../src/integration/handlers/messenger-backfill/range"

const fromAt = new Date("2023-01-01T00:00:00.000Z")
const toAt = new Date("2026-01-01T00:00:00.000Z")

describe("Messenger backfill exact range", () => {
  test.each([
    ["2022-12-31T23:59:59.999Z", "older"],
    ["2023-01-01T00:00:00.000Z", "in-range"],
    ["2024-06-01T00:00:00.000Z", "in-range"],
    ["2026-01-01T00:00:00.000Z", "in-range"],
    ["2026-01-01T00:00:00.001Z", "newer"],
    [undefined, "invalid"],
    ["not-a-date", "invalid"],
  ] as const)("classifies %s as %s", (value, expected) => {
    expect(classifyMessageTimestamp(value, { fromAt, toAt })).toBe(expected)
  })

  test("does not skip a conversation updated after toAt", () => {
    expect(shouldStopConversationWalk("2026-07-01T00:00:00.000Z", fromAt)).toBe(
      false,
    )
  })

  test("stops only once conversation updated_time is older than fromAt", () => {
    expect(shouldStopConversationWalk("2022-12-31T23:59:59.999Z", fromAt)).toBe(
      true,
    )
    expect(shouldStopConversationWalk("2023-01-01T00:00:00.000Z", fromAt)).toBe(
      false,
    )
    expect(shouldStopConversationWalk(undefined, fromAt)).toBe(false)
  })
})
