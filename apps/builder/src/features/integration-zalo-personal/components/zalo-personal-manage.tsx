"use client"

import type { IntegrationZaloPersonalResource } from "@chatbotx.io/business/integration-zalo-personal"
import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@chatbotx.io/ui/components/ui/card"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useHookFormAction } from "@next-safe-action/adapter-react-hook-form/hooks"
import { useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { orpc } from "@/lib/orpc/query"
import {
  connectZaloPersonalAction,
  disconnectZaloPersonalAction,
} from "../actions/connect.action"
import { createZaloPersonalConnectionSchema } from "../schema"

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
  const invalidateConnections = () =>
    queryClient.invalidateQueries({ queryKey: orpc.connectionsAPI.key() })
  const { form, handleSubmitWithAction } = useHookFormAction(
    connectZaloPersonalAction.bind(null, workspaceId),
    zodResolver(createZaloPersonalConnectionSchema),
    {
      actionProps: {
        onSuccess: async () => {
          toast.success(t("fields.zalo_personal.connected"))
          form.reset()
          await invalidateConnections()
          router.refresh()
        },
        onError: ({ error }) => {
          if (error.serverError) {
            toast.error(error.serverError)
          }
        },
      },
      formProps: {
        defaultValues: {
          accountId: "",
          bridgeUrl: "",
          keyId: "",
          name: "",
          secret: "",
        },
      },
    },
  )

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
              <Button
                onClick={async () => {
                  await disconnectZaloPersonalAction(workspaceId, {
                    accountId: integration.accountId,
                  })
                  await invalidateConnections()
                  router.refresh()
                }}
                type="button"
                variant="destructive"
              >
                {t("actions.disconnect")}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
      {canCreate && (
        <Card>
          <CardHeader>
            <CardTitle>{t("fields.zalo_personal.connect")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form
                className="grid gap-4 md:grid-cols-2"
                onSubmit={handleSubmitWithAction}
              >
                <InputField
                  label={t("fields.zalo_personal.name")}
                  name="name"
                />
                <InputField
                  label={t("fields.zalo_personal.accountId")}
                  name="accountId"
                  required
                />
                <InputField
                  label={t("fields.zalo_personal.bridgeUrl")}
                  name="bridgeUrl"
                  required
                  type="url"
                />
                <InputField
                  label={t("fields.zalo_personal.keyId")}
                  name="keyId"
                  required
                />
                <InputField
                  label={t("fields.zalo_personal.secret")}
                  name="secret"
                  required
                  type="password"
                />
                <div className="flex items-end">
                  <Button type="submit">{t("actions.connect")}</Button>
                </div>
              </form>
            </Form>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
