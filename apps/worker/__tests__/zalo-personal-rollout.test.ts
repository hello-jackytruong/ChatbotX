import { describe, expect, it } from "vitest"
import { isZaloPersonalAccountAllowed } from "../src/lib/zalo-personal-rollout"

describe("Zalo Personal rollout gates", () => {
  it("fails closed unless both the global flag and exact account allowlist match", () => {
    expect(
      isZaloPersonalAccountAllowed({
        accountId: "account-1",
        enabled: false,
        allowlist: "account-1",
      }),
    ).toBe(false)
    expect(
      isZaloPersonalAccountAllowed({
        accountId: "account-1",
        enabled: true,
        allowlist: "account-2",
      }),
    ).toBe(false)
    expect(
      isZaloPersonalAccountAllowed({
        accountId: "account-1",
        enabled: true,
        allowlist: " account-1,account-2 ",
      }),
    ).toBe(true)
  })
})
