"use client"

import { DateTimePickerField } from "@chatbotx.io/ui/components/form/date-picker-field"
import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Checkbox } from "@chatbotx.io/ui/components/ui/checkbox"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import { zodResolver } from "@hookform/resolvers/zod"
import { useHookFormAction } from "@next-safe-action/adapter-react-hook-form/hooks"
import { Loader2Icon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useId } from "react"
import { Controller } from "react-hook-form"
import { toast } from "sonner"
import { scheduleMessengerBackfillAction } from "../actions"
import {
  type ScheduleMessengerBackfillRequest,
  scheduleMessengerBackfillRequest,
} from "../schema/action"

type MessengerPageOption = {
  id: string
  name: string
  pageId: string
}

const DAY_MS = 24 * 60 * 60 * 1000

function ResourceCheckbox({
  name,
  label,
  description,
}: {
  name: "includeContacts" | "includeMessages"
  label: string
  description?: string
}) {
  const id = useId()

  return (
    <Controller<ScheduleMessengerBackfillRequest>
      name={name}
      render={({ field }) => (
        <Label
          className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 font-normal"
          htmlFor={id}
        >
          <Checkbox
            checked={Boolean(field.value)}
            id={id}
            onCheckedChange={(checked) => field.onChange(Boolean(checked))}
          />
          <div className="space-y-0.5">
            <span className="block font-medium leading-5">{label}</span>
            {description ? (
              <p className="text-muted-foreground text-xs leading-5">
                {description}
              </p>
            ) : null}
          </div>
        </Label>
      )}
    />
  )
}

export function MessengerBackfillForm({
  workspaceId,
  pages,
}: {
  workspaceId: string
  pages: MessengerPageOption[]
}) {
  const t = useTranslations("messengerBackfill")
  const router = useRouter()
  const now = new Date()

  const { form, handleSubmitWithAction } = useHookFormAction(
    scheduleMessengerBackfillAction.bind(null, workspaceId),
    zodResolver(scheduleMessengerBackfillRequest),
    {
      actionProps: {
        onSuccess: () => {
          toast.success(t("messages.scheduled"))
          router.refresh()
        },
        onError: ({ error }) => {
          toast.error(error.serverError ?? t("messages.scheduleFailed"))
        },
      },
      formProps: {
        mode: "onChange",
        defaultValues: {
          integrationId: pages[0]?.id ?? "",
          rangeFromAt: new Date(now.getTime() - 30 * DAY_MS),
          rangeToAt: now,
          includeContacts: true,
          includeMessages: true,
        },
      },
      errorMapProps: {},
    },
  )

  const resourceError = form.formState.errors.includeContacts?.message

  return (
    <Form {...form}>
      <form className="space-y-5" onSubmit={handleSubmitWithAction}>
        <SelectField
          disabled={pages.length === 0}
          label={t("fields.page")}
          name="integrationId"
          options={pages.map((page) => ({
            value: page.id,
            label: `${page.name} (${page.pageId})`,
          }))}
          placeholder={t("fields.pagePlaceholder")}
          required
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <DateTimePickerField
            disabled={{ after: new Date() }}
            displayFormat={{ hour24: "yyyy-MM-dd HH:mm" }}
            granularity="minute"
            label={t("fields.from")}
            name="rangeFromAt"
            required
            saveFormat="iso"
          />
          <DateTimePickerField
            disabled={{ after: new Date() }}
            displayFormat={{ hour24: "yyyy-MM-dd HH:mm" }}
            granularity="minute"
            label={t("fields.to")}
            name="rangeToAt"
            required
            saveFormat="iso"
          />
        </div>
        <p className="text-muted-foreground text-xs leading-5">
          {t("fields.timezoneHint")}
        </p>

        <fieldset className="space-y-2">
          <legend className="mb-2 font-medium text-sm">
            {t("fields.resources")}
          </legend>
          <ResourceCheckbox
            label={t("fields.contacts")}
            name="includeContacts"
          />
          <ResourceCheckbox
            description={t("fields.messagesHint")}
            label={t("fields.messages")}
            name="includeMessages"
          />
          {resourceError ? (
            <p className="font-medium text-destructive text-sm" role="alert">
              {resourceError}
            </p>
          ) : null}
        </fieldset>

        {pages.length === 0 ? (
          <p className="text-muted-foreground text-sm" role="status">
            {t("emptyPages")}
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button
            className="min-h-11 w-full sm:w-auto"
            disabled={pages.length === 0 || form.formState.isSubmitting}
            type="submit"
          >
            {form.formState.isSubmitting ? (
              <Loader2Icon className="animate-spin motion-reduce:animate-none" />
            ) : null}
            {t("submit")}
          </Button>
        </div>
      </form>
    </Form>
  )
}
