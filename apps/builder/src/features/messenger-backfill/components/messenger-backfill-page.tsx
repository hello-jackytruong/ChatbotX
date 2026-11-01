"use client"

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@chatbotx.io/ui/components/ui/alert"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@chatbotx.io/ui/components/ui/card"
import { InfoIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { MessengerProfileBackfillCard } from "@/features/messenger-profile-backfill/components/messenger-profile-backfill-card"
import type { getMessengerBackfillPageData } from "../queries/get-messenger-backfill-page-data.query"
import { MessengerBackfillForm } from "./messenger-backfill-form"
import { MessengerBackfillRuns } from "./messenger-backfill-runs"

type PageData = Awaited<ReturnType<typeof getMessengerBackfillPageData>>

export function MessengerBackfillPage({
  workspaceId,
  pages,
  runs,
  profileRuns,
}: PageData & { workspaceId: string }) {
  const t = useTranslations("messengerBackfill")

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="space-y-1">
        <h1 className="text-pretty font-semibold text-2xl tracking-tight">
          {t("title")}
        </h1>
        <p className="max-w-3xl text-muted-foreground text-sm leading-6">
          {t("description")}
        </p>
      </div>

      <Alert variant="warning">
        <InfoIcon aria-hidden="true" />
        <AlertTitle>{t("limitation.title")}</AlertTitle>
        <AlertDescription>{t("limitation.description")}</AlertDescription>
      </Alert>

      <MessengerProfileBackfillCard
        pages={pages}
        runs={profileRuns}
        workspaceId={workspaceId}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t("formTitle")}</CardTitle>
          <CardDescription>{t("formDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <MessengerBackfillForm pages={pages} workspaceId={workspaceId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("history.title")}</CardTitle>
          <CardDescription>{t("history.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <MessengerBackfillRuns
            pages={pages}
            runs={runs}
            workspaceId={workspaceId}
          />
        </CardContent>
      </Card>
    </div>
  )
}
