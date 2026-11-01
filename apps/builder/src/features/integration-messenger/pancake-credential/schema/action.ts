import { z } from "zod"

export const replacePancakeCredentialRequest = z.object({
  token: z.string().trim().min(1).max(4096),
})

export type ReplacePancakeCredentialRequest = z.infer<
  typeof replacePancakeCredentialRequest
>
