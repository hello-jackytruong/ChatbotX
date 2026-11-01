import { describe, expect, test } from "vitest"
import {
  buildMessengerAutoBackfillJobId,
  buildMessengerBackfillJobId,
  buildMessengerBackfillPageJobId,
} from "../src/queues/integration/messenger-backfill-job-ids"

describe("Messenger backfill job ids", () => {
  test("separates attempts and continuation pages", () => {
    expect(buildMessengerBackfillJobId({ runId: "run-1", attempts: 2 })).toBe(
      "messenger-backfill-run-1-2",
    )
    expect(
      buildMessengerBackfillPageJobId({
        runId: "run-1",
        attempts: 2,
        pageNumber: 4,
      }),
    ).toBe("messenger-backfill-run-1-2-page-4")
  })

  test("deduplicates one automatic probe per Page and time bucket", () => {
    expect(
      buildMessengerAutoBackfillJobId({
        integrationId: "page-1",
        timeBucket: 42,
      }),
    ).toBe("messenger-auto-backfill-page-1-42")
  })
})
