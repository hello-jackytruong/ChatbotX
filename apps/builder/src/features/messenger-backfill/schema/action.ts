import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"

export const scheduleMessengerBackfillRequest = z
  .object({
    integrationId: zodBigintAsString(),
    rangeFromAt: z.coerce.date(),
    rangeToAt: z.coerce.date(),
    includeContacts: z.boolean(),
    includeMessages: z.boolean(),
  })
  .superRefine((data, context) => {
    if (data.rangeFromAt >= data.rangeToAt || data.rangeToAt > new Date()) {
      context.addIssue({
        code: "custom",
        message: "Choose a valid past time range.",
        path: ["rangeToAt"],
      })
    }
    if (!(data.includeContacts || data.includeMessages)) {
      context.addIssue({
        code: "custom",
        message: "Select Contacts, Messages, or both.",
        path: ["includeContacts"],
      })
    }
  })

export type ScheduleMessengerBackfillRequest = z.infer<
  typeof scheduleMessengerBackfillRequest
>

export const messengerBackfillRunRequest = z.object({
  runId: z.string().min(1),
})
export type MessengerBackfillRunRequest = z.infer<
  typeof messengerBackfillRunRequest
>
