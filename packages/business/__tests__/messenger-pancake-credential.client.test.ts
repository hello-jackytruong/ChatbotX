import { afterEach, describe, expect, test, vi } from "vitest"
import {
  PancakeCredentialVerificationError,
  verifyPancakePageToken,
} from "../src/messenger-pancake-credential/client"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("verifyPancakePageToken", () => {
  test("performs a minimal authenticated read for the bound Page", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, conversations: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await verifyPancakePageToken({
      pageId: "page/with slash",
      token: "pancake-secret",
    })

    const requestUrl = fetchMock.mock.calls[0]?.[0] as URL
    expect(requestUrl.pathname).toBe(
      "/api/public_api/v2/pages/page%2Fwith%20slash/conversations",
    )
    expect(requestUrl.searchParams.get("page_access_token")).toBe(
      "pancake-secret",
    )
    expect(requestUrl.searchParams.get("fields")).toBe("id")
  })

  test("throws a generic error that never exposes the token or request URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")))

    const promise = verifyPancakePageToken({
      pageId: "page-1",
      token: "never-leak-this-token",
    })

    await expect(promise).rejects.toBeInstanceOf(
      PancakeCredentialVerificationError,
    )
    await expect(promise).rejects.not.toThrow("never-leak-this-token")
    await expect(promise).rejects.not.toThrow("pages.fm")
  })

  test("rejects an HTTP-200 Pancake error envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, error_code: 100 }), {
          status: 200,
        }),
      ),
    )

    await expect(
      verifyPancakePageToken({ pageId: "page-1", token: "bad" }),
    ).rejects.toBeInstanceOf(PancakeCredentialVerificationError)
  })
})
