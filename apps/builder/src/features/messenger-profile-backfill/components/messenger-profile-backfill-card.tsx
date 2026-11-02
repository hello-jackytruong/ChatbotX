"use client"

import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { SwitchField } from "@chatbotx.io/ui/components/form/switch-field"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@chatbotx.io/ui/components/ui/card"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useHookFormAction } from "@next-safe-action/adapter-react-hook-form/hooks"
import { Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useFormatter, useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useEffect } from "react"
import { toast } from "sonner"
import {
  cancelMessengerProfileBackfillAction,
  retryMessengerProfileBackfillAction,
  scheduleMessengerProfileBackfillAction,
} from "../actions"
import {
  type ScheduleMessengerProfileBackfillRequest,
  scheduleMessengerProfileBackfillRequest,
} from "../schema/action"

type Page = {
  id: string
  name: string
  pageId: string
  pancakeConfigured: boolean
}
type Run = {
  id: string
  integrationMessengerId: string
  policy: "pancake" | "meta" | "pancakeThenMeta"
  overwriteExisting: boolean
  status: "init" | "running" | "succeeded" | "partial" | "failed" | "cancelled"
  currentScan: number
  updatedCount: number
  avatarCount: number
  skippedCount: number
  failedCount: number
  currentError: string | null
  cancelRequestedAt: Date | null
  createdAt: Date
}

const active = (status: Run["status"]) =>
  status === "init" || status === "running"

export function MessengerProfileBackfillCard({
  workspaceId,
  pages,
  runs,
}: {
  workspaceId: string
  pages: Page[]
  runs: Run[]
}) {
  const t = useTranslations("messengerProfileBackfill")
  const router = useRouter()
  const formatter = useFormatter()
  const { form, handleSubmitWithAction, action } = useHookFormAction(
    scheduleMessengerProfileBackfillAction.bind(null, workspaceId),
    zodResolver(scheduleMessengerProfileBackfillRequest),
    {
      formProps: {
        defaultValues: {
          integrationMessengerId: pages[0]?.id ?? "",
          policy: "pancake",
          overwriteExisting: false,
        } satisfies ScheduleMessengerProfileBackfillRequest,
      },
      actionProps: {
        onSuccess: () => {
          toast.success(t("messages.scheduled"))
          router.refresh()
        },
        onError: ({ error }) =>
          toast.error(error.serverError ?? t("messages.failed")),
      },
    },
  )
  const cancel = useAction(
    cancelMessengerProfileBackfillAction.bind(null, workspaceId),
    {
      onSuccess: () => router.refresh(),
      onError: ({ error }) =>
        toast.error(error.serverError ?? t("messages.failed")),
    },
  )
  const retry = useAction(
    retryMessengerProfileBackfillAction.bind(null, workspaceId),
    {
      onSuccess: () => router.refresh(),
      onError: ({ error }) =>
        toast.error(error.serverError ?? t("messages.failed")),
    },
  )

  useEffect(() => {
    if (!runs.some((run) => active(run.status))) {
      return
    }
    const timer = window.setInterval(() => router.refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [router, runs])

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <Form {...form}>
          <form
            className="grid gap-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end"
            onSubmit={handleSubmitWithAction}
          >
            <SelectField
              label={t("fields.page")}
              name="integrationMessengerId"
              options={pages.map((page) => ({
                value: page.id,
                label: `${page.name} (${page.pageId})${page.pancakeConfigured ? "" : ` — ${t("notConfigured")}`}`,
              }))}
              required
            />
            <SwitchField
              label={t("modes.overwrite")}
              name="overwriteExisting"
            />
            <SelectField
              label={t("fields.policy")}
              name="policy"
              options={[
                { value: "pancake", label: t("policies.pancake") },
                { value: "meta", label: t("policies.meta") },
                {
                  value: "pancakeThenMeta",
                  label: t("policies.pancakeThenMeta"),
                },
              ]}
              required
            />
            <Button
              disabled={pages.length === 0 || action.isExecuting}
              type="submit"
            >
              {action.isExecuting ? (
                <Loader2Icon className="animate-spin" />
              ) : null}
              {t("start")}
            </Button>
          </form>
        </Form>
        <p className="text-muted-foreground text-xs">
          {form.watch("overwriteExisting")
            ? t("overwriteWarning")
            : t("missingOnly")}
        </p>

        <div className="space-y-3">
          {runs.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("empty")}</p>
          ) : null}
          {runs.map((run) => {
            const page = pages.find(
              (item) => item.id === run.integrationMessengerId,
            )
            return (
              <div className="space-y-3 rounded-md border p-4" key={run.id}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">
                      {page?.name ?? run.integrationMessengerId}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t(`policies.${run.policy}`)} ·{" "}
                      {t(
                        run.overwriteExisting
                          ? "modes.overwrite"
                          : "modes.missingOnly",
                      )}{" "}
                      · {t(`status.${run.status}`)} ·{" "}
                      {formatter.dateTime(run.createdAt, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </p>
                  </div>
                  {active(run.status) ? (
                    <Button
                      disabled={
                        cancel.isPending || Boolean(run.cancelRequestedAt)
                      }
                      onClick={() => cancel.execute({ runId: run.id })}
                      size="sm"
                      variant="outline"
                    >
                      <XIcon /> {t("cancel")}
                    </Button>
                  ) : null}
                  {!active(run.status) &&
                  ["failed", "partial", "cancelled"].includes(run.status) ? (
                    <Button
                      disabled={retry.isPending}
                      onClick={() => retry.execute({ runId: run.id })}
                      size="sm"
                      variant="outline"
                    >
                      <RefreshCwIcon /> {t("retry")}
                    </Button>
                  ) : null}
                </div>
                <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
                  {(
                    [
                      "currentScan",
                      "updatedCount",
                      "avatarCount",
                      "skippedCount",
                      "failedCount",
                    ] as const
                  ).map((key) => (
                    <div key={key}>
                      <dt className="text-muted-foreground text-xs">
                        {t(`counters.${key}`)}
                      </dt>
                      <dd className="font-medium tabular-nums">
                        {formatter.number(run[key])}
                      </dd>
                    </div>
                  ))}
                </dl>
                {run.currentError ? (
                  <p className="text-destructive text-sm">{run.currentError}</p>
                ) : null}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
