import {
  Integration,
  type IntegrationDefinition,
  probeVerify,
  SdkException,
} from "@chatbotx.io/sdk"
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
    strategy: "api_key",
    multiAccount: false,
    configFields: [
      { name: "bridgeUrl", type: "url", required: true },
      { name: "keyId", type: "string", required: true },
      { name: "secret", type: "secret", required: true },
      { name: "accountId", type: "string", required: true },
      { name: "name", type: "string", required: false },
    ],
    fromCredentials: async (credentials: {
      bridgeUrl: string
      keyId: string
      secret: string
      accountId: string
      name?: string
    }) => {
      const auth: ZaloPersonalAuthValue = {
        authType: "custom",
        accountId: credentials.accountId,
        bridgeUrl: credentials.bridgeUrl,
        keyId: credentials.keyId,
        secret: credentials.secret,
        ...(credentials.name ? { name: credentials.name } : {}),
      }
      const health = await new ZaloPersonalBridgeClient({
        baseUrl: auth.bridgeUrl,
        keyId: auth.keyId,
        secret: auth.secret,
      }).health()
      if (health.ready !== true || health.version !== 1) {
        throw new SdkException("Zalo Personal bridge is not ready")
      }
      return auth
    },
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
          }).health()
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
  disconnect: () => Promise.resolve(),
}

export const integration = new Integration(config)
