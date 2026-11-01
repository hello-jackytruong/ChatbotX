import { describe, expect, test } from "vitest"
import {
  classifyMessengerBackfillError,
  nextSmallerMessagePageLimit,
} from "../src/integration/handlers/messenger-backfill/error-policy"

describe("Messenger backfill error policy", () => {
  test.each([
    [{ code: 100, subCode: 33 }, "unavailable"],
    [{ code: "100", subCode: "33" }, "unavailable"],
    [{ code: 230 }, "unavailable"],
    [{ code: 4 }, "retryable"],
    [{ code: 17 }, "retryable"],
    [{ code: 613 }, "retryable"],
    [{ httpStatusCode: 429 }, "retryable"],
    [{ httpStatusCode: 503 }, "retryable"],
    [{ code: 190, type: "OAuthException" }, "auth"],
    [{ code: 10 }, "permission"],
    [{ code: 100 }, "unknown"],
  ] as const)("classifies %o as %s", (error, expected) => {
    expect(classifyMessengerBackfillError(error)).toBe(expected)
  })

  test("recognizes Meta's oversized-response error separately", () => {
    expect(
      classifyMessengerBackfillError({
        code: 1,
        message: "Please reduce the amount of data you're asking for",
      }),
    ).toBe("data-too-large")
  })

  test("shrinks page size without falling below the safe minimum", () => {
    expect(nextSmallerMessagePageLimit(499)).toBe(249)
    expect(nextSmallerMessagePageLimit(26)).toBe(25)
    expect(nextSmallerMessagePageLimit(25)).toBeNull()
  })
})
