import {
  Integration,
  type IntegrationDefinition,
  probeVerify,
  SdkException,
} from "@chatbotx.io/sdk"
import { z } from "zod"
import { ZaloPersonalBridgeClient } from "./bridge-client"
import { messageHandlers } from "./handlers/message"
import type {
  ZaloPersonalActions,
  ZaloPersonalAuthValue,
  ZaloPersonalConfig,
} from "./schema/definition"

const config: IntegrationDefinition<
  ZaloPersonalConfig,
  ZaloPersonalAuthValue,
  ZaloPersonalActions
> = {
  name: "zalo_personal",
  channels: { channel: { message: messageHandlers } },
  actions: {},
  connection: {
    kind: "channel",
    strategy: "qr_code",
    multiAccount: false,
    configFields: [],
    describe: (auth) => ({
      sourceId: auth.accountId,
      displayName:
        typeof auth.name === "string" && auth.name.trim()
          ? auth.name
          : `Zalo Personal ${auth.accountId}`,
    }),
    verify: async ({ auth }) =>
      await probeVerify(
        async () => {
          const health = await new ZaloPersonalBridgeClient({
            baseUrl: auth.bridgeUrl,
            keyId: auth.keyId,
            secret: auth.secret,
          }).health(auth.accountId)
          if (health.ready !== true || health.version !== 1) {
            throw new SdkException("Zalo Personal bridge is not ready")
          }
          return health
        },
        { label: "Zalo Personal bridge" },
      ),
  },
  handleRequest: () =>
    Promise.reject(
      new SdkException(
        "Zalo Personal uses the authenticated internal bridge, not webhooks",
      ),
    ),
  // A connected mapping is intentionally not eligible for the onboarding
  // cleanup endpoint. Disconnecting ChatbotX must never archive a live ZaloCRM
  // account; the existing bridge/runtime lifecycle owns provider teardown.
  disconnect: () => Promise.resolve(),
}

/** Server-only compatibility for pre-QR API clients; never advertised by the catalog/UI. */
export async function authenticateLegacyZaloPersonalCredentials(
  credentials: Record<string, unknown>,
): Promise<ZaloPersonalAuthValue> {
  const parsed = z
    .object({
      accountId: z.string().trim().min(1),
      bridgeUrl: z
        .url()
        .refine(
          (value) =>
            value.startsWith("https://") || value.startsWith("http://"),
        ),
      keyId: z.string().trim().min(1),
      name: z.string().trim().min(1).max(80).optional(),
      secret: z.string().trim().min(1),
    })
    .strict()
    .parse(credentials)
  const auth: ZaloPersonalAuthValue = { authType: "custom", ...parsed }
  const health = await new ZaloPersonalBridgeClient({
    baseUrl: auth.bridgeUrl,
    keyId: auth.keyId,
    secret: auth.secret,
  }).health(auth.accountId)
  if (health.ready !== true || health.version !== 1) {
    throw new SdkException("Zalo Personal bridge is not ready")
  }
  return auth
}

export const integration = new Integration(config)
