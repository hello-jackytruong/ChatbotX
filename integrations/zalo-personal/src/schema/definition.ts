import { customAuthSchema } from "@chatbotx.io/sdk"
import { z } from "zod"

const nonEmpty = z.string().trim().min(1)
const bridgeUrl = z
  .url()
  .refine(
    (value) => value.startsWith("https://") || value.startsWith("http://"),
    "Bridge URL must use HTTP or HTTPS",
  )

export const zaloPersonalAuthSchema = customAuthSchema.extend({
  accountId: nonEmpty,
  bridgeUrl,
  keyId: nonEmpty,
  secret: nonEmpty,
  managedBy: z.literal("chatbotx_qr").optional(),
  connectSessionId: nonEmpty.optional(),
})

export type ZaloPersonalAuthValue = z.infer<typeof zaloPersonalAuthSchema>

export type ZaloPersonalConfig = Record<string, unknown>
export type ZaloPersonalActions = Record<string, never>

export const bridgeEventSchema = z.object({
  version: z.literal(1),
  eventId: nonEmpty,
  accountId: nonEmpty,
  accountSequence: z.string().regex(/^\d+$/),
  fenceToken: z.string().regex(/^\d+$/),
  kind: z.enum([
    "account_status",
    "delivered",
    "friend",
    "group",
    "message",
    "reaction",
    "seen",
    "typing",
    "undo",
  ]),
  providerEventId: z.string().nullable().optional(),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: z.string().datetime({ offset: true }),
})

export type BridgeEvent = z.infer<typeof bridgeEventSchema>

export const bridgeEventPageSchema = z.object({
  version: z.literal(1),
  accountId: nonEmpty,
  nextSequence: z.string().regex(/^\d+$/),
  highWaterMark: z.string().regex(/^\d+$/),
  retentionFloor: z.string().regex(/^\d+$/),
  events: z.array(bridgeEventSchema),
})

export type BridgeEventPage = z.infer<typeof bridgeEventPageSchema>
