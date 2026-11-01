"use client"

import type { MessengerPancakeCredentialStatus } from "@chatbotx.io/business/messenger-pancake-credential"
import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@chatbotx.io/ui/components/ui/card"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useHookFormAction } from "@next-safe-action/adapter-react-hook-form/hooks"
import { CheckCircle2Icon, CircleIcon, Loader2Icon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useFormatter, useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { toast } from "sonner"
import { DeleteCredentialDialog } from "@/features/platform-credentials/delete-credential-dialog"
import { deletePancakeCredentialAction } from "../actions/delete-pancake-credential.action"
import { replacePancakeCredentialAction } from "../actions/replace-pancake-credential.action"
import {
  type ReplacePancakeCredentialRequest,
  replacePancakeCredentialRequest,
} from "../schema/action"

type Props = {
  workspaceId: string
  integrationMessengerId: string
  status: MessengerPancakeCredentialStatus
  canEdit: boolean
}

export function PancakeCredentialCard({
  workspaceId,
  integrationMessengerId,
  status,
  canEdit,
}: Props) {
  const t = useTranslations()
  const formatter = useFormatter()
  const router = useRouter()
  const boundArgs = [workspaceId, integrationMessengerId] as const

  const { form, handleSubmitWithAction, action } = useHookFormAction(
    replacePancakeCredentialAction.bind(null, ...boundArgs),
    zodResolver(replacePancakeCredentialRequest),
    {
      formProps: {
        defaultValues: { token: "" } satisfies ReplacePancakeCredentialRequest,
      },
      actionProps: {
        onSuccess: () => {
          form.reset({ token: "" })
          router.refresh()
          toast.success(t("messengerPancakeCredential.messages.saved"))
        },
        onError: ({ error }) => {
          toast.error(error.serverError ?? t("messages.unknownError"))
        },
      },
    },
  )

  const deleteAction = useAction(
    deletePancakeCredentialAction.bind(null, ...boundArgs),
    {
      onSuccess: () => {
        router.refresh()
        toast.success(t("messengerPancakeCredential.messages.deleted"))
      },
      onError: ({ error }) => {
        toast.error(error.serverError ?? t("messages.unknownError"))
      },
    },
  )
  const isSaving = action.isExecuting

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("messengerPancakeCredential.title")}</CardTitle>
        <CardDescription>
          {t("messengerPancakeCredential.description")}
        </CardDescription>
        <CardAction>
          <Badge variant={status.configured ? "default" : "secondary"}>
            {status.configured ? (
              <CheckCircle2Icon aria-hidden="true" />
            ) : (
              <CircleIcon aria-hidden="true" />
            )}
            {status.configured
              ? t("messengerPancakeCredential.status.configured")
              : t("messengerPancakeCredential.status.unconfigured")}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {status.configured ? (
          <p className="text-muted-foreground text-sm">
            {t("messengerPancakeCredential.verifiedAt", {
              date: formatter.dateTime(status.verifiedAt, {
                dateStyle: "medium",
                timeStyle: "short",
              }),
            })}
          </p>
        ) : null}

        {canEdit ? (
          <Form {...form}>
            <form
              aria-busy={isSaving}
              className="flex flex-col gap-4"
              onSubmit={handleSubmitWithAction}
            >
              <InputField<ReplacePancakeCredentialRequest>
                autoComplete="new-password"
                description={
                  status.configured
                    ? t("messengerPancakeCredential.token.replaceDescription")
                    : t("messengerPancakeCredential.token.description")
                }
                disabled={isSaving || deleteAction.isPending}
                label={t("messengerPancakeCredential.token.label")}
                name="token"
                placeholder={t("messengerPancakeCredential.token.placeholder")}
                required
                spellCheck={false}
                type="password"
              />
              <div
                className={
                  status.configured
                    ? "flex items-center justify-between gap-3"
                    : "flex justify-end"
                }
              >
                {status.configured ? (
                  <DeleteCredentialDialog
                    disabled={isSaving}
                    feature={t("messengerPancakeCredential.featureName")}
                    isDeleting={deleteAction.isPending}
                    onConfirm={() => deleteAction.execute()}
                  />
                ) : null}
                <Button
                  disabled={
                    isSaving ||
                    deleteAction.isPending ||
                    !form.formState.isDirty
                  }
                  type="submit"
                >
                  {isSaving ? (
                    <Loader2Icon aria-hidden="true" className="animate-spin" />
                  ) : null}
                  {status.configured
                    ? t("messengerPancakeCredential.actions.replace")
                    : t("messengerPancakeCredential.actions.save")}
                </Button>
              </div>
            </form>
          </Form>
        ) : (
          <p className="text-muted-foreground text-sm">
            {t("messengerPancakeCredential.readOnly")}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
