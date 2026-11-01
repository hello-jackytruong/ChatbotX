import { describe, expect, test } from "vitest"
import { computeAutoBackfillRange } from "../src/integration/handlers/messenger-backfill/auto"

const now = new Date("2026-11-01T12:00:00.000Z")

describe("computeAutoBackfillRange", () => {
  test("uses the normal 15-minute window without a checkpoint", () => {
    expect(
      computeAutoBackfillRange({
        now,
        lastAutoBackfillAt: null,
        windowMinutes: 15,
      }),
    ).toEqual({
      fromAt: new Date("2026-11-01T11:45:00.000Z"),
      toAt: now,
    })
  })

  test("uses a five-minute overlap from an older successful checkpoint", () => {
    expect(
      computeAutoBackfillRange({
        now,
        lastAutoBackfillAt: new Date("2026-11-01T10:00:00.000Z"),
        windowMinutes: 15,
      }),
    ).toEqual({
      fromAt: new Date("2026-11-01T09:55:00.000Z"),
      toAt: now,
    })
  })

  test("still looks back at least 15 minutes for a recent checkpoint", () => {
    expect(
      computeAutoBackfillRange({
        now,
        lastAutoBackfillAt: new Date("2026-11-01T11:58:00.000Z"),
        windowMinutes: 15,
      }).fromAt,
    ).toEqual(new Date("2026-11-01T11:45:00.000Z"))
  })
})
