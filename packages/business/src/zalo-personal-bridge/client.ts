const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i
type BridgeClientConfig = { baseUrl: string; kid: string; secret: string }

function allowedBridgeOrigin(baseUrl: string): string {
  const candidate = new URL(baseUrl)
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
    throw new Error("ZALO_PERSONAL_BRIDGE_ORIGIN_NOT_ALLOWED")
  }
  return candidate.origin
}

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

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

async function sha256(value: string): Promise<string> {
  return toHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  )
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
    ),
  )
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
  if (!SHA256_HEX_PATTERN.test(signature)) {
    return false
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["verify"],
  )
  return await crypto.subtle.verify(
    "HMAC",
    key,
    decodeHex(signature),
    new TextEncoder().encode(value),
  )
}

async function sign(input: {
  kid: string
  secret: string
  method: string
  pathAndQuery: string
  timestamp: number
  nonce: string
  body: unknown
}): Promise<string> {
  const body =
    input.body == null ? "" : JSON.stringify(canonicalize(input.body))
  const bodyHash = await sha256(body)
  const canonical = [
    input.kid,
    input.method.toUpperCase(),
    canonicalPath(input.pathAndQuery),
    String(input.timestamp),
    input.nonce,
    bodyHash,
  ].join("\n")
  return await hmac(input.secret, canonical)
}

async function verifyResponseSignature(input: {
  secret: string
  correlationId: string
  body: unknown
  signature: string
}): Promise<boolean> {
  const bodyHash = await sha256(JSON.stringify(canonicalize(input.body)))
  return await verifyHmac(
    input.secret,
    `${input.correlationId}\n${bodyHash}`,
    input.signature,
  )
}

export class ZaloPersonalBridgeHttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(code)
    this.name = "ZaloPersonalBridgeHttpError"
    this.status = status
    this.code = code
  }
}

export class ZaloPersonalBridgeClient {
  private readonly config: BridgeClientConfig
  private readonly fetcher: typeof fetch

  constructor(config: BridgeClientConfig, fetcher: typeof fetch = fetch) {
    this.config = { ...config, baseUrl: allowedBridgeOrigin(config.baseUrl) }
    this.fetcher = fetcher
  }

  acceptCommand(
    command: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/internal/bridge/v1/commands", command)
  }

  provisionAccount(input: {
    connectSessionId: string
    workspaceId: string
  }): Promise<Record<string, unknown>> {
    return this.request("POST", "/internal/bridge/v1/onboarding", {
      version: 1,
      ...input,
    })
  }

  getCommand(commandId: string): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/internal/bridge/v1/commands/${encodeURIComponent(commandId)}`,
      null,
    )
  }

  listEvents(input: { accountId: string; after: string; limit?: number }) {
    const query = new URLSearchParams({
      after: input.after,
      limit: String(input.limit ?? 100),
    })
    return this.request(
      "GET",
      `/internal/bridge/v1/accounts/${encodeURIComponent(input.accountId)}/events?${query}`,
      null,
    )
  }

  bindAccount(input: {
    accountId: string
    workspaceId: string
    inboxId: string
  }) {
    return this.request(
      "PUT",
      `/internal/bridge/v1/accounts/${encodeURIComponent(input.accountId)}/binding`,
      {
        version: 1,
        workspaceId: input.workspaceId,
        inboxId: input.inboxId,
      },
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

  reconcile(input: { accountId: string; commandId?: string }) {
    return this.request("POST", "/internal/bridge/v1/reconcile", input)
  }

  health(accountId: string) {
    return this.request(
      "GET",
      `/internal/bridge/v1/accounts/${encodeURIComponent(accountId)}/health`,
      null,
    )
  }

  private async request(
    method: string,
    pathAndQuery: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const timestamp = Math.floor(Date.now() / 1000)
    const nonce = crypto.randomUUID()
    const signature = await sign({
      ...this.config,
      method,
      pathAndQuery,
      timestamp,
      nonce,
      body,
    })
    const response = await this.fetcher(
      new URL(pathAndQuery, this.config.baseUrl),
      {
        method,
        redirect: "error",
        headers: {
          ...(body == null ? {} : { "content-type": "application/json" }),
          "x-bridge-kid": this.config.kid,
          "x-bridge-nonce": nonce,
          "x-bridge-signature": signature,
          "x-bridge-timestamp": String(timestamp),
        },
        body: body == null ? undefined : JSON.stringify(canonicalize(body)),
      },
    )
    const payload = (await response.json()) as Record<string, unknown>
    if (!response.ok) {
      throw new ZaloPersonalBridgeHttpError(
        response.status,
        typeof payload.error === "string"
          ? payload.error
          : "BRIDGE_REQUEST_FAILED",
      )
    }
    const correlationId = response.headers.get("x-bridge-correlation-id") ?? ""
    const responseSignature =
      response.headers.get("x-bridge-response-signature") ?? ""
    if (
      !(
        correlationId === nonce &&
        (await verifyResponseSignature({
          secret: this.config.secret,
          correlationId,
          body: payload,
          signature: responseSignature,
        }))
      )
    ) {
      throw new ZaloPersonalBridgeHttpError(
        502,
        "INVALID_BRIDGE_RESPONSE_SIGNATURE",
      )
    }
    return payload
  }
}
