import { customAuthSchema } from "@chatbotx.io/sdk"
import { z } from "zod"

const nonEmpty = z.string().trim().min(1)
const bridgeUrl = z
  .url()
  .refine(
    (value) => value.startsWith("https://") || value.startsWith("http://"),
    "Bridge URL must use HTTP or HTTPS",
  )

export const zaloPersonalRuntimeAuthSchema = customAuthSchema.extend({
  accountId: nonEmpty,
  bridgeUrl,
  keyId: nonEmpty,
  secret: nonEmpty,
})

export type ZaloPersonalRuntimeAuth = z.infer<
  typeof zaloPersonalRuntimeAuthSchema
>

export const integrationZaloPersonalResource = z.object({
  id: z.string(),
  inboxId: z.string(),
  workspaceId: z.string(),
  accountId: z.string(),
  bridgeUrl,
  keyId: z.string(),
  name: z.string(),
  status: z.enum([
    "connected",
    "degraded",
    "needs_reauth",
    "paused",
    "disconnected",
  ]),
})

export type IntegrationZaloPersonalResource = z.infer<
  typeof integrationZaloPersonalResource
>

export const createZaloPersonalConnectionSchema = z.object({
  accountId: nonEmpty,
  bridgeUrl,
  keyId: nonEmpty,
  name: z.string().trim().min(1).max(80).optional(),
  secret: nonEmpty,
})
