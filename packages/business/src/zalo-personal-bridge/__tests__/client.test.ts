import { createHash, createHmac } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ZaloPersonalBridgeClient,
  ZaloPersonalBridgeHttpError,
} from "../client"

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/

function signedResponse(secret: string, payload: Record<string, unknown>) {
  const correlationId = "health"
  const bodyHash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
  const signature = createHmac("sha256", secret)
    .update(`${correlationId}\n${bodyHash}`)
    .digest("hex")
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-bridge-correlation-id": correlationId,
      "x-bridge-response-signature": signature,
    },
  })
}

describe("ZaloPersonalBridgeClient", () => {
  beforeEach(() => {
    vi.stubEnv(
      "ZALO_PERSONAL_BRIDGE_ALLOWED_ORIGINS",
      "http://zalo-personal:3001",
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("signs requests without placing the service secret in URL or body", async () => {
    const secret = "synthetic-service-secret"
    const fetcher = vi.fn().mockResolvedValue(
      signedResponse(secret, {
        ready: true,
        version: 1,
      }),
    )
    const client = new ZaloPersonalBridgeClient(
      {
        baseUrl: "http://zalo-personal:3001",
        kid: "client-1",
        secret,
      },
      fetcher,
    )

    await expect(client.health()).resolves.toEqual({ ready: true, version: 1 })
    const [url, init] = fetcher.mock.calls[0]
    expect(String(url)).not.toContain(secret)
    expect(String(init.body ?? "")).not.toContain(secret)
    expect(init.redirect).toBe("error")
    expect(init.headers["x-bridge-signature"]).toMatch(SHA256_HEX_PATTERN)
  })

  it("rejects an unsigned or tampered response", async () => {
    const client = new ZaloPersonalBridgeClient(
      {
        baseUrl: "http://zalo-personal:3001",
        kid: "client-1",
        secret: "synthetic-service-secret",
      },
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ready: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    )

    await expect(client.health()).rejects.toBeInstanceOf(
      ZaloPersonalBridgeHttpError,
    )
  })

  it("rejects a workspace-supplied bridge origin outside deployment policy", () => {
    expect(
      () =>
        new ZaloPersonalBridgeClient({
          baseUrl: "http://169.254.169.254",
          kid: "client-1",
          secret: "synthetic-service-secret",
        }),
    ).toThrow("ZALO_PERSONAL_BRIDGE_ORIGIN_NOT_ALLOWED")
  })
})
