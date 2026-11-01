import { MESSENGER_SCOPES } from "@chatbotx.io/integration-messenger"
import { describe, expect, test } from "vitest"
import { FACEBOOK_SSO_SCOPES } from "../src/lib/auth/upgrade-facebook-account"

describe("Facebook SSO scopes", () => {
  test("keeps email for sign-in without adding it to Messenger channel OAuth", () => {
    expect(MESSENGER_SCOPES).not.toContain("email")
    expect(FACEBOOK_SSO_SCOPES).toEqual(["email", ...MESSENGER_SCOPES])
  })
})
