import { bridgeEventPageSchema } from "./schema/definition"

const encoder = new TextEncoder()
const HEX_PATTERN = /^[a-f0-9]{64}$/i

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")

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

function canonicalPath(pathAndQuery: string): string {
  const url = new URL(pathAndQuery, "http://bridge.internal")
  const entries = [...url.searchParams.entries()].sort(
    ([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
  )
  const query = new URLSearchParams(entries).toString()
  return `${url.pathname}${query ? `?${query}` : ""}`
}

async function sha256(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)))
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  )
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))
}

const decodeHex = (value: string): ArrayBuffer =>
  Uint8Array.from(
    value.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  ).buffer as ArrayBuffer

async function verifyHmac(
  secret: string,
  value: string,
  signature: string,
): Promise<boolean> {
  if (!HEX_PATTERN.test(signature)) {
    return false
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["verify"],
  )
  return await crypto.subtle.verify(
    "HMAC",
    key,
    decodeHex(signature),
    encoder.encode(value),
  )
}

export type ZaloPersonalBridgeClientConfig = {
  baseUrl: string
  keyId: string
  secret: string
}

export class ZaloPersonalBridgeError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number) {
    super(code)
    this.name = "ZaloPersonalBridgeError"
    this.code = code
    this.status = status
  }
}

export class ZaloPersonalBridgeClient {
  private readonly config: ZaloPersonalBridgeClientConfig
  private readonly fetcher: typeof fetch

  constructor(
    config: ZaloPersonalBridgeClientConfig,
    fetcher: typeof fetch = fetch,
  ) {
    const candidate = new URL(config.baseUrl)
    const allowedOrigins = (
      process.env.ZALO_PERSONAL_BRIDGE_ALLOWED_ORIGINS ?? ""
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => new URL(value).origin)
    if (
      candidate.username ||
      candidate.password ||
      !allowedOrigins.includes(candidate.origin)
    ) {
      throw new ZaloPersonalBridgeError(
        "ZALO_PERSONAL_BRIDGE_ORIGIN_NOT_ALLOWED",
        400,
      )
    }
    this.config = { ...config, baseUrl: candidate.origin }
    this.fetcher = fetcher
  }

  acceptCommand(command: Record<string, unknown>) {
    return this.request("POST", "/internal/bridge/v1/commands", command)
  }

  provisionAccount(input: { connectSessionId: string; workspaceId: string }) {
    return this.request("POST", "/internal/bridge/v1/onboarding", {
      version: 1,
      ...input,
    })
  }

  getCommand(commandId: string) {
    return this.request(
      "GET",
      `/internal/bridge/v1/commands/${encodeURIComponent(commandId)}`,
      null,
    )
  }

  async listEvents(input: {
    accountId: string
    after: string
    limit?: number
  }) {
    const query = new URLSearchParams({
      after: input.after,
      limit: String(input.limit ?? 100),
    })
    return bridgeEventPageSchema.parse(
      await this.request(
        "GET",
        `/internal/bridge/v1/accounts/${encodeURIComponent(input.accountId)}/events?${query}`,
        null,
      ),
    )
  }

  reconcile(input: {
    accountId: string
    commandId?: string
    echoId?: string
    providerMessageId?: string
  }) {
    return this.request("POST", "/internal/bridge/v1/reconcile", input)
  }

  health(accountId: string) {
    return this.request(
      "GET",
      `/internal/bridge/v1/accounts/${encodeURIComponent(accountId)}/health`,
      null,
    )
  }

  cleanupOnboardingAccount(input: {
    accountId: string
    connectSessionId: string
  }) {
    return this.request(
      "POST",
      `/internal/bridge/v1/accounts/${encodeURIComponent(input.accountId)}/onboarding-cleanup`,
      { version: 1, connectSessionId: input.connectSessionId },
    )
  }

  private async request(
    method: string,
    pathAndQuery: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const timestamp = Math.floor(Date.now() / 1000)
    const nonce = crypto.randomUUID()
    const canonicalBody = body == null ? "" : JSON.stringify(canonicalize(body))
    const canonical = [
      this.config.keyId,
      method,
      canonicalPath(pathAndQuery),
      String(timestamp),
      nonce,
      await sha256(canonicalBody),
    ].join("\n")
    const response = await this.fetcher(
      new URL(pathAndQuery, this.config.baseUrl),
      {
        method,
        redirect: "error",
        headers: {
          ...(body == null ? {} : { "content-type": "application/json" }),
          "x-bridge-kid": this.config.keyId,
          "x-bridge-nonce": nonce,
          "x-bridge-signature": await hmac(this.config.secret, canonical),
          "x-bridge-timestamp": String(timestamp),
        },
        body: body == null ? undefined : canonicalBody,
      },
    )
    const payload = (await response.json()) as Record<string, unknown>
    if (!response.ok) {
      throw new ZaloPersonalBridgeError(
        typeof payload.error === "string"
          ? payload.error
          : "BRIDGE_REQUEST_FAILED",
        response.status,
      )
    }
    const correlationId = response.headers.get("x-bridge-correlation-id") ?? ""
    const signature = response.headers.get("x-bridge-response-signature") ?? ""
    const bodyHash = await sha256(JSON.stringify(canonicalize(payload)))
    const signatureInput = `${correlationId}\n${bodyHash}`
    if (
      !(
        correlationId === nonce &&
        (await verifyHmac(this.config.secret, signatureInput, signature))
      )
    ) {
      throw new ZaloPersonalBridgeError(
        "INVALID_BRIDGE_RESPONSE_SIGNATURE",
        502,
      )
    }
    return payload
  }
}
