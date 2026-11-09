import { createHash, createHmac } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ZaloPersonalBridgeClient,
  ZaloPersonalBridgeHttpError,
} from "../client"

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/
const REQUEST_NONCE = "00000000-0000-4000-8000-000000000001"

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    )
  }
  return value
}

function signedResponse(
  secret: string,
  payload: Record<string, unknown>,
  correlationId = REQUEST_NONCE,
) {
  const bodyHash = createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)))
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
    vi.spyOn(crypto, "randomUUID").mockReturnValue(REQUEST_NONCE)
    vi.stubEnv(
      "ZALO_PERSONAL_BRIDGE_ALLOWED_ORIGINS",
      "http://zalo-personal:3001",
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
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

    await expect(client.health("account-1")).resolves.toEqual({
      ready: true,
      version: 1,
    })
    const [url, init] = fetcher.mock.calls[0]
    expect(String(url)).toBe(
      "http://zalo-personal:3001/internal/bridge/v1/accounts/account-1/health",
    )
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

    await expect(client.health("account-1")).rejects.toBeInstanceOf(
      ZaloPersonalBridgeHttpError,
    )
  })

  it("binds a provisioned account to its persisted ChatbotX inbox", async () => {
    const secret = "synthetic-service-secret"
    const payload = {
      version: 1,
      accountId: "account-1",
      workspaceId: "workspace-1",
      inboxId: "inbox-1",
      status: "bound",
    }
    const fetcher = vi.fn().mockResolvedValue(signedResponse(secret, payload))
    const client = new ZaloPersonalBridgeClient(
      {
        baseUrl: "http://zalo-personal:3001",
        kid: "client-1",
        secret,
      },
      fetcher,
    )

    await expect(
      client.bindAccount({
        accountId: "account-1",
        workspaceId: "workspace-1",
        inboxId: "inbox-1",
      }),
    ).resolves.toEqual(payload)
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "http://zalo-personal:3001/internal/bridge/v1/accounts/account-1/binding",
    )
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "PUT" })
  })

  it("retires a managed onboarding account through the account-scoped route", async () => {
    const secret = "synthetic-service-secret"
    const payload = { version: 1, accountId: "account-1", status: "cleaned" }
    const fetcher = vi.fn().mockResolvedValue(signedResponse(secret, payload))
    const client = new ZaloPersonalBridgeClient(
      {
        baseUrl: "http://zalo-personal:3001",
        kid: "client-1",
        secret,
      },
      fetcher,
    )

    await expect(
      client.cleanupOnboardingAccount({
        accountId: "account-1",
        connectSessionId: "session-1",
      }),
    ).resolves.toEqual(payload)
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "http://zalo-personal:3001/internal/bridge/v1/accounts/account-1/onboarding-cleanup",
    )
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: '{"connectSessionId":"session-1","version":1}',
    })
  })

  it("provisions an account without putting the provisioning secret in the request body", async () => {
    const secret = "synthetic-provisioning-secret"
    const payload = {
      version: 1,
      accountId: "account-1",
      keyId: "account-client-1",
      secret: "account-secret-1",
    }
    const fetcher = vi.fn().mockResolvedValue(signedResponse(secret, payload))
    const client = new ZaloPersonalBridgeClient(
      {
        baseUrl: "http://zalo-personal:3001",
        kid: "provisioner-1",
        secret,
      },
      fetcher,
    )

    await expect(
      client.provisionAccount({
        connectSessionId: "session-1",
        workspaceId: "workspace-1",
      }),
    ).resolves.toEqual(payload)
    const [url, init] = fetcher.mock.calls[0]
    expect(String(url)).toBe(
      "http://zalo-personal:3001/internal/bridge/v1/onboarding",
    )
    expect(String(init.body)).toContain('"connectSessionId":"session-1"')
    expect(String(init.body)).not.toContain(secret)
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

  it("rejects a valid response signature replayed from another request", async () => {
    const secret = "synthetic-service-secret"
    const client = new ZaloPersonalBridgeClient(
      {
        baseUrl: "http://zalo-personal:3001",
        kid: "client-1",
        secret,
      },
      vi
        .fn()
        .mockResolvedValue(
          signedResponse(secret, { ready: true }, "other-request-nonce"),
        ),
    )

    await expect(client.health("account-1")).rejects.toMatchObject({
      code: "INVALID_BRIDGE_RESPONSE_SIGNATURE",
    })
  })
})
