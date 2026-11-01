import { describe, expect, test } from "vitest"
import { coexistRunTypes } from "../src/partials/coexist-sync-run"

describe("Messenger backfill run type", () => {
  test("accepts backfill without changing existing run types", () => {
    expect(coexistRunTypes.options).toEqual([
      "coexist",
      "contact_scan",
      "backfill",
    ])
  })
})
