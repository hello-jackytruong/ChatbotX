import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"

export const scheduleMessengerProfileBackfillRequest = z.object({
  integrationMessengerId: zodBigintAsString(),
  policy: z.enum(["pancake", "meta", "pancakeThenMeta"]).default("pancake"),
})
export type ScheduleMessengerProfileBackfillRequest = z.infer<
  typeof scheduleMessengerProfileBackfillRequest
>

export const messengerProfileBackfillRunRequest = z.object({
  runId: zodBigintAsString(),
})
