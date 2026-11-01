import { describe, expect, test } from "vitest"
import { scheduleMessengerBackfillRequest } from "../action"

const valid = {
  integrationId: "11762437435337018",
  rangeFromAt: new Date("2022-01-01T00:00:00.000Z"),
  rangeToAt: new Date("2026-01-01T00:00:00.000Z"),
  includeContacts: true,
  includeMessages: false,
}

describe("scheduleMessengerBackfillRequest", () => {
  test("accepts ranges older than three years", () => {
    expect(scheduleMessengerBackfillRequest.safeParse(valid).success).toBe(true)
  })

  test("requires at least one selected resource", () => {
    expect(
      scheduleMessengerBackfillRequest.safeParse({
        ...valid,
        includeContacts: false,
        includeMessages: false,
      }).success,
    ).toBe(false)
  })

  test("rejects inverted and future ranges", () => {
    expect(
      scheduleMessengerBackfillRequest.safeParse({
        ...valid,
        rangeFromAt: valid.rangeToAt,
        rangeToAt: valid.rangeFromAt,
      }).success,
    ).toBe(false)
    expect(
      scheduleMessengerBackfillRequest.safeParse({
        ...valid,
        rangeToAt: new Date(Date.now() + 60_000),
      }).success,
    ).toBe(false)
  })
})
