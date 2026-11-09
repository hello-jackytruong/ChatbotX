import { z } from "zod"

const nonEmpty = z.string().trim().min(1)

/** Legacy server-side credential shape retained for backward compatibility. The standard UI uses QR onboarding and never renders these fields. */
export const createZaloPersonalConnectionSchema = z.object({
  accountId: nonEmpty,
  bridgeUrl: z
    .url()
    .refine(
      (value) => value.startsWith("https://") || value.startsWith("http://"),
      "Bridge URL must use HTTP or HTTPS",
    ),
  keyId: nonEmpty,
  name: z.string().trim().min(1).max(80).optional(),
  secret: nonEmpty,
})
