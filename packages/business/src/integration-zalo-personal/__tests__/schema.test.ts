import { describe, expect, it } from "vitest"
import {
  integrationZaloPersonalResource,
  zaloPersonalRuntimeAuthSchema,
} from "../schema"

describe("Zalo Personal integration schemas", () => {
  it("keeps the runtime secret out of public resources", () => {
    const resource = integrationZaloPersonalResource.parse({
      id: "1",
      inboxId: "2",
      workspaceId: "3",
      accountId: "account-1",
      bridgeUrl: "https://zalo.internal",
      keyId: "kid-1",
      name: "Sales account",
      status: "connected",
    })

    expect(resource).not.toHaveProperty("secret")
    expect(resource).not.toHaveProperty("encryptedSecret")
    expect(resource).not.toHaveProperty("auth")
  })

  it("requires the full service credential only for runtime auth", () => {
    expect(
      zaloPersonalRuntimeAuthSchema.parse({
        authType: "custom",
        accountId: "account-1",
        bridgeUrl: "https://zalo.internal",
        keyId: "kid-1",
        secret: "secret-1",
      }),
    ).toMatchObject({ accountId: "account-1", secret: "secret-1" })
  })

  it("rejects non-HTTP bridge protocols", () => {
    expect(() =>
      zaloPersonalRuntimeAuthSchema.parse({
        authType: "custom",
        accountId: "account-1",
        bridgeUrl: "file:///etc/passwd",
        keyId: "kid-1",
        secret: "secret-1",
      }),
    ).toThrow("Bridge URL must use HTTP or HTTPS")
  })
})
