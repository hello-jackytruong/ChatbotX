import z from "zod"

export const zaloPersonalCommandStatuses = z.enum([
  "pending",
  "processing",
  "succeeded",
  "rejected",
  "failed",
  "unknown_outcome",
])

export const zaloPersonalBridgeDirections = z.enum(["inbound", "outbound"])

export type ZaloPersonalCommandStatus = z.infer<
  typeof zaloPersonalCommandStatuses
>
export type ZaloPersonalBridgeDirection = z.infer<
  typeof zaloPersonalBridgeDirections
>
