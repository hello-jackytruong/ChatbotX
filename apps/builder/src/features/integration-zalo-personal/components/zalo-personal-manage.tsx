"use client"

import type { IntegrationZaloPersonalResource } from "@chatbotx.io/business/integration-zalo-personal"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@chatbotx.io/ui/components/ui/card"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2Icon } from "lucide-react"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { useInvalidateInboxes } from "@/features/inboxes/provider/inbox-hook"
import { orpc } from "@/lib/orpc/query"
import {
  cancelZaloPersonalConnectAction,
  connectZaloPersonalAction,
  disconnectZaloPersonalAction,
  reconnectZaloPersonalAction,
} from "../actions/connect.action"

const POLL_INTERVAL_MS = 1500
const ACTIVE_SESSION_STATUSES = new Set([
  "pending",
  "authorized",
  "awaiting_selection",
])

const qrImageSource = (value: string): string =>
  value.startsWith("data:") ? value : `data:image/png;base64,${value}`

export function ZaloPersonalManage({
  workspaceId,
  integrations,
  canCreate,
}: {
  workspaceId: string
  integrations: IntegrationZaloPersonalResource[]
  canCreate: boolean
}) {
  const t = useTranslations()
  const router = useRouter()
  const queryClient = useQueryClient()
  const invalidateInboxes = useInvalidateInboxes()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const completedSession = useRef<string | null>(null)
  const invalidateConnections = useCallback(
    () =>
      queryClient.invalidateQueries({ queryKey: orpc.connectionsAPI.key() }),
    [queryClient],
  )
  const onError = ({ error }: { error: { serverError?: string } }) => {
    if (error.serverError) {
      toast.error(error.serverError)
    }
  }

  const sessionQuery = useQuery(
    orpc.connectSessionsAPI.getConnectSessionAPI.queryOptions({
      input: { workspaceId, id: sessionId ?? "" },
      enabled: Boolean(sessionId),
      refetchInterval: (query) =>
        ACTIVE_SESSION_STATUSES.has(query.state.data?.status ?? "")
          ? POLL_INTERVAL_MS
          : false,
    }),
  )
  const session = sessionQuery.data

  const { execute: connect, isPending: isConnecting } = useAction(
    connectZaloPersonalAction.bind(null, workspaceId),
    {
      onSuccess: ({ data }) => {
        if (data?.sessionId) {
          setSessionId(data.sessionId)
        }
      },
      onError,
    },
  )
  const { execute: reconnect, isPending: isReconnecting } = useAction(
    reconnectZaloPersonalAction.bind(null, workspaceId),
    {
      onSuccess: ({ data }) => {
        if (data?.sessionId) {
          setSessionId(data.sessionId)
        }
      },
      onError,
    },
  )
  const { execute: cancel, isPending: isCancelling } = useAction(
    cancelZaloPersonalConnectAction.bind(null, workspaceId),
    {
      onSuccess: () => setSessionId(null),
      onError,
    },
  )

  useEffect(() => {
    if (
      !(
        session?.status === "completed" &&
        completedSession.current !== session.id
      )
    ) {
      return
    }
    completedSession.current = session.id
    Promise.all([invalidateConnections(), invalidateInboxes()])
      .then(() => {
        toast.success(t("fields.zalo_personal.connected"))
        router.push(`/space/${workspaceId}/inbox`)
        router.refresh()
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error))
      })
  }, [
    invalidateInboxes,
    router,
    session,
    t,
    workspaceId,
    invalidateConnections,
  ])

  const qrAction =
    session?.nextAction?.type === "display_qr" ? session.nextAction : null
  const isTerminalFailure =
    session?.status === "failed" ||
    session?.status === "expired" ||
    session?.status === "cancelled"

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("fields.zalo_personal.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {integrations.map((integration) => (
            <div
              className="flex items-center justify-between gap-3 rounded-md border p-3"
              key={integration.id}
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{integration.name}</p>
                <p className="truncate text-muted-foreground text-sm">
                  {integration.accountId} ·{" "}
                  {t(`fields.zalo_personal.status.${integration.status}`)}
                </p>
              </div>
              <div className="flex gap-2">
                {(integration.status === "needs_reauth" ||
                  integration.status === "disconnected") && (
                  <Button
                    disabled={isReconnecting}
                    onClick={() =>
                      reconnect({ accountId: integration.accountId })
                    }
                    type="button"
                    variant="secondary"
                  >
                    {isReconnecting && <Loader2Icon className="animate-spin" />}
                    {t("fields.zalo_personal.reconnect")}
                  </Button>
                )}
                <Button
                  onClick={async () => {
                    await disconnectZaloPersonalAction(workspaceId, {
                      accountId: integration.accountId,
                    })
                    await Promise.all([
                      invalidateConnections(),
                      invalidateInboxes(),
                    ])
                    router.refresh()
                  }}
                  type="button"
                  variant="destructive"
                >
                  {t("actions.disconnect")}
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {canCreate && (
        <Card>
          <CardHeader>
            <CardTitle>{t("fields.zalo_personal.connect")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4 text-center">
            {!sessionId && (
              <Button
                disabled={isConnecting}
                onClick={() => connect()}
                type="button"
              >
                {isConnecting && <Loader2Icon className="animate-spin" />}
                {t("fields.zalo_personal.startQr")}
              </Button>
            )}

            {sessionId && !session && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2Icon className="animate-spin" />
                {t("fields.zalo_personal.preparing")}
              </div>
            )}

            {qrAction?.state === "ready" && qrAction.qrImage && (
              <>
                <Image
                  alt={t("fields.zalo_personal.qrAlt")}
                  className="rounded-md border bg-white p-2"
                  height={280}
                  src={qrImageSource(qrAction.qrImage)}
                  unoptimized
                  width={280}
                />
                <p className="text-muted-foreground text-sm">
                  {t("fields.zalo_personal.scanQr")}
                </p>
              </>
            )}

            {qrAction && qrAction.state !== "ready" && !isTerminalFailure && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2Icon className="animate-spin" />
                {t(`fields.zalo_personal.qrState.${qrAction.state}`)}
              </div>
            )}

            {isTerminalFailure && (
              <div className="flex flex-col items-center gap-3">
                <p className="text-destructive text-sm">
                  {t("fields.zalo_personal.qrFailed")}
                </p>
                <Button onClick={() => connect()} type="button">
                  {t("fields.zalo_personal.newQr")}
                </Button>
              </div>
            )}

            {sessionId && session?.status !== "completed" && (
              <Button
                disabled={isCancelling}
                onClick={() => cancel({ id: sessionId })}
                type="button"
                variant="ghost"
              >
                {isCancelling && <Loader2Icon className="animate-spin" />}
                {t("actions.cancel")}
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
