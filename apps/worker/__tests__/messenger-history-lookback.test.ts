import { afterEach, describe, expect, test, vi } from "vitest"

const DAY_MS = 24 * 60 * 60 * 1000

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe("Messenger history lookback", () => {
  test("uses the configured three-year storage window", async () => {
    vi.stubEnv("MESSENGER_HISTORY_LOOKBACK_DAYS", "1095")
    vi.resetModules()

    const { STORE_WINDOW_MS } = await import(
      "../src/integration/handlers/coexist/messenger-helpers"
    )

    expect(STORE_WINDOW_MS).toBe(1095 * DAY_MS)
  })
})
