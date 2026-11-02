import { describe, expect, test } from "vitest"
import { scheduleMessengerProfileBackfillRequest } from "../src/features/messenger-profile-backfill/schema/action"

describe("Messenger profile backfill request", () => {
  test("defaults to missing-only and accepts overwrite mode", () => {
    expect(
      scheduleMessengerProfileBackfillRequest.parse({
        integrationMessengerId: "123",
        policy: "pancake",
      }),
    ).toMatchObject({ overwriteExisting: false })

    expect(
      scheduleMessengerProfileBackfillRequest.parse({
        integrationMessengerId: "123",
        policy: "pancake",
        overwriteExisting: true,
      }),
    ).toMatchObject({ overwriteExisting: true })
  })
})
