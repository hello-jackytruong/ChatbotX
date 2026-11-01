"use client"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@chatbotx.io/ui/components/ui/alert-dialog"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Card, CardContent } from "@chatbotx.io/ui/components/ui/card"
import { cn } from "@chatbotx.io/ui/lib/utils"
import { Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useFormatter, useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  cancelMessengerBackfillAction,
  retryMessengerBackfillAction,
} from "../actions"
import type { getMessengerBackfillPageData } from "../queries/get-messenger-backfill-page-data.query"

type PageData = Awaited<ReturnType<typeof getMessengerBackfillPageData>>
type BackfillRun = PageData["runs"][number]
type MessengerPageOption = PageData["pages"][number]
type RunStatus = BackfillRun["status"]
type PendingAction = { runId: string; type: "cancel" | "retry" } | null

const ACTIVE_STATUSES: RunStatus[] = ["init", "running"]
const RETRYABLE_STATUSES: RunStatus[] = ["failed", "partial"]
const POLL_INTERVAL_MS = 5000
const PROCESSED_PAGE_STEP_PATTERN = /^page (\d+) processed$/i
const DATE_TIME_FORMAT_OPTIONS = {
  dateStyle: "medium",
  timeStyle: "short",
} as const

const STATUS_CLASS_NAMES: Record<RunStatus, string> = {
  init: "border-border bg-muted text-foreground",
  running:
    "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200",
  succeeded:
    "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  partial:
    "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  failed:
    "border-destructive/30 bg-destructive/10 text-destructive dark:border-destructive/50",
  waiting: "border-border bg-muted text-muted-foreground",
}

function AutoRefresh() {
  const router = useRouter()

  useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [router])

  return null
}

function StatusBadge({ status }: { status: RunStatus }) {
  const t = useTranslations("messengerBackfill")
  const active = ACTIVE_STATUSES.includes(status)

  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium text-xs",
        STATUS_CLASS_NAMES[status],
      )}
    >
      {active ? (
        <Loader2Icon
          aria-hidden="true"
          className="size-3 animate-spin motion-reduce:animate-none"
        />
      ) : null}
      {t(`status.${status}`)}
    </span>
  )
}

function DateValue({ value }: { value: Date | null }) {
  const formatter = useFormatter()
  if (!value) {
    return <span className="text-muted-foreground">—</span>
  }
  return <>{formatter.dateTime(value, DATE_TIME_FORMAT_OPTIONS)}</>
}

function RunPhase({ run }: { run: BackfillRun }) {
  const t = useTranslations("messengerBackfill")
  const processedPage = run.currentStep?.match(PROCESSED_PAGE_STEP_PATTERN)?.[1]

  if (processedPage) {
    return <>{t("phase.pageProcessed", { page: Number(processedPage) })}</>
  }
  if (run.status === "init") {
    return <>{t("phase.queued")}</>
  }
  if (run.status === "running") {
    return <>{t("phase.importing")}</>
  }
  return <>{t("phase.complete")}</>
}

function RunCounters({ run }: { run: BackfillRun }) {
  const t = useTranslations("messengerBackfill")
  const formatter = useFormatter()
  const counters = [
    ["scanned", run.currentScan],
    ["contacts", run.importedContactCount],
    ["messages", run.importedMessageCount],
    ["duplicates", run.skippedCount],
    ["unavailable", run.skippedUnavailableCount],
    ["failed", run.failedCount],
  ] as const

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
      {counters.map(([label, value]) => (
        <div key={label}>
          <dt className="text-muted-foreground text-xs">
            {t(`counters.${label}`)}
          </dt>
          <dd className="font-medium tabular-nums">
            {formatter.number(value)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function RunActions({
  run,
  pageName,
  pendingAction,
  onCancel,
  onRetry,
}: {
  run: BackfillRun
  pageName: string
  pendingAction: PendingAction
  onCancel: (runId: string) => void
  onRetry: (runId: string) => void
}) {
  const t = useTranslations("messengerBackfill")
  const pending = pendingAction !== null
  const thisActionPending = pendingAction?.runId === run.id

  if (ACTIVE_STATUSES.includes(run.status)) {
    return (
      <AlertDialog>
        <AlertDialogTrigger
          render={
            <Button
              aria-label={t("actions.cancelLabel", { page: pageName })}
              className="min-h-11"
              disabled={pending || Boolean(run.cancelRequestedAt)}
              size="sm"
              type="button"
              variant="outline"
            >
              {thisActionPending ? (
                <Loader2Icon
                  aria-hidden="true"
                  className="animate-spin motion-reduce:animate-none"
                />
              ) : (
                <XIcon aria-hidden="true" />
              )}
              {run.cancelRequestedAt
                ? t("actions.cancelling")
                : t("actions.cancel")}
            </Button>
          }
        />
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("actions.cancelTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("actions.cancelDescription", { page: pageName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>
              {t("actions.keepRunning")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={pending}
              onClick={() => onCancel(run.id)}
            >
              {thisActionPending ? (
                <Loader2Icon
                  aria-hidden="true"
                  className="animate-spin motion-reduce:animate-none"
                />
              ) : null}
              {t("actions.confirmCancel")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  if (RETRYABLE_STATUSES.includes(run.status)) {
    return (
      <Button
        aria-label={t("actions.retryLabel", { page: pageName })}
        className="min-h-11"
        disabled={pending}
        onClick={() => onRetry(run.id)}
        size="sm"
        type="button"
        variant="outline"
      >
        {thisActionPending ? (
          <Loader2Icon
            aria-hidden="true"
            className="animate-spin motion-reduce:animate-none"
          />
        ) : (
          <RefreshCwIcon aria-hidden="true" />
        )}
        {t("actions.retry")}
      </Button>
    )
  }

  return null
}

function MobileRunCard({
  run,
  page,
  pendingAction,
  onCancel,
  onRetry,
}: {
  run: BackfillRun
  page: MessengerPageOption | undefined
  pendingAction: PendingAction
  onCancel: (runId: string) => void
  onRetry: (runId: string) => void
}) {
  const t = useTranslations("messengerBackfill")
  const pageName = page?.name ?? t("unknownPage")

  return (
    <Card className="gap-4 py-4 shadow-none">
      <CardContent className="space-y-4 px-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-medium">{pageName}</p>
            {page?.pageId ? (
              <p className="text-muted-foreground text-xs">{page.pageId}</p>
            ) : null}
          </div>
          <StatusBadge status={run.status} />
        </div>
        <p className="text-sm">
          <DateValue value={run.rangeFromAt} />
          <span aria-hidden="true" className="px-1.5 text-muted-foreground">
            →
          </span>
          <DateValue value={run.rangeToAt} />
        </p>
        <p className="text-muted-foreground text-xs">
          <RunPhase run={run} />
          <span aria-hidden="true"> · </span>
          {run.includeContacts ? t("fields.contacts") : null}
          {run.includeContacts && run.includeMessages ? " · " : null}
          {run.includeMessages ? t("fields.messages") : null}
        </p>
        <RunCounters run={run} />
        {run.currentError ? (
          <p className="break-words text-destructive text-sm" role="status">
            {run.currentError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-end justify-between gap-3 border-t pt-3">
          <p className="text-muted-foreground text-xs">
            {t("started")} <DateValue value={run.startedAt} />
            <br />
            {t("finished")} <DateValue value={run.finishedAt} />
          </p>
          <RunActions
            onCancel={onCancel}
            onRetry={onRetry}
            pageName={pageName}
            pendingAction={pendingAction}
            run={run}
          />
        </div>
      </CardContent>
    </Card>
  )
}

export function MessengerBackfillRuns({
  workspaceId,
  pages,
  runs,
}: {
  workspaceId: string
  pages: MessengerPageOption[]
  runs: BackfillRun[]
}) {
  const t = useTranslations("messengerBackfill")
  const router = useRouter()
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)
  const pageById = useMemo(
    () => new Map(pages.map((page) => [page.id, page])),
    [pages],
  )
  const hasActiveRuns = runs.some((run) => ACTIVE_STATUSES.includes(run.status))

  const cancel = useAction(
    cancelMessengerBackfillAction.bind(null, workspaceId),
    {
      onSuccess: ({ data }) => {
        setPendingAction(null)
        if (data?.cancelled) {
          toast.success(t("messages.cancelRequested"))
        } else {
          toast.info(t("messages.alreadyFinished"))
        }
        router.refresh()
      },
      onError: ({ error }) => {
        setPendingAction(null)
        toast.error(error.serverError ?? t("messages.actionFailed"))
      },
    },
  )
  const retry = useAction(
    retryMessengerBackfillAction.bind(null, workspaceId),
    {
      onSuccess: () => {
        setPendingAction(null)
        toast.success(t("messages.retryScheduled"))
        router.refresh()
      },
      onError: ({ error }) => {
        setPendingAction(null)
        toast.error(error.serverError ?? t("messages.actionFailed"))
      },
    },
  )

  const cancelRun = (runId: string) => {
    setPendingAction({ runId, type: "cancel" })
    cancel.execute({ runId })
  }
  const retryRun = (runId: string) => {
    setPendingAction({ runId, type: "retry" })
    retry.execute({ runId })
  }

  if (runs.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("history.empty")}</p>
  }

  return (
    <div aria-live="polite">
      {hasActiveRuns ? <AutoRefresh /> : null}

      <div className="space-y-3 md:hidden">
        {runs.map((run) => (
          <MobileRunCard
            key={run.id}
            onCancel={cancelRun}
            onRetry={retryRun}
            page={pageById.get(run.integrationId)}
            pendingAction={pendingAction}
            run={run}
          />
        ))}
      </div>

      <div className="hidden overflow-x-auto rounded-lg border md:block">
        <table className="w-full min-w-[980px] border-collapse text-sm">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium" scope="col">
                {t("history.page")}
              </th>
              <th className="px-3 py-2 font-medium" scope="col">
                {t("history.range")}
              </th>
              <th className="px-3 py-2 font-medium" scope="col">
                {t("history.status")}
              </th>
              <th className="px-3 py-2 font-medium" scope="col">
                {t("history.progress")}
              </th>
              <th className="px-3 py-2 font-medium" scope="col">
                {t("history.timing")}
              </th>
              <th className="px-3 py-2 text-right font-medium" scope="col">
                {t("history.actions")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {runs.map((run) => {
              const page = pageById.get(run.integrationId)
              const pageName = page?.name ?? t("unknownPage")
              return (
                <tr className="align-top" key={run.id}>
                  <td className="px-3 py-3">
                    <p className="font-medium">{pageName}</p>
                    {page?.pageId ? (
                      <p className="text-muted-foreground text-xs">
                        {page.pageId}
                      </p>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-xs">
                    <DateValue value={run.rangeFromAt} />
                    <br />
                    <DateValue value={run.rangeToAt} />
                    <p className="mt-1 text-muted-foreground">
                      {run.includeContacts ? t("fields.contacts") : null}
                      {run.includeContacts && run.includeMessages
                        ? " · "
                        : null}
                      {run.includeMessages ? t("fields.messages") : null}
                    </p>
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge status={run.status} />
                    <p className="mt-1 max-w-44 text-muted-foreground text-xs">
                      <RunPhase run={run} />
                    </p>
                    {run.currentError ? (
                      <p
                        className="mt-1 max-w-56 break-words text-destructive text-xs"
                        title={run.currentError}
                      >
                        {run.currentError}
                      </p>
                    ) : null}
                  </td>
                  <td className="min-w-64 px-3 py-3">
                    <RunCounters run={run} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-xs">
                    <span className="text-muted-foreground">
                      {t("started")}
                    </span>{" "}
                    <DateValue value={run.startedAt} />
                    <br />
                    <span className="text-muted-foreground">
                      {t("finished")}
                    </span>{" "}
                    <DateValue value={run.finishedAt} />
                  </td>
                  <td className="px-3 py-3 text-right">
                    <RunActions
                      onCancel={cancelRun}
                      onRetry={retryRun}
                      pageName={pageName}
                      pendingAction={pendingAction}
                      run={run}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
