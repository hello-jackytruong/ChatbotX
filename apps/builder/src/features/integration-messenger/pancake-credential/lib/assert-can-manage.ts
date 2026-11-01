import { ChatbotXException } from "@chatbotx.io/business/errors"
import { getTranslations } from "next-intl/server"
import { hasWorkspacePermission } from "@/lib/auth/permission-routes"

/** Pancake Page tokens may be changed only by a real workspace super admin. */
export async function assertCanManagePancakeCredential(ctx: {
  workspaceMemberPermissions: Parameters<typeof hasWorkspacePermission>[0]
  isSupportSession: boolean
}): Promise<void> {
  const t = await getTranslations()
  if (!hasWorkspacePermission(ctx.workspaceMemberPermissions, "superAdmin")) {
    throw new ChatbotXException(t("errors.superAdminRequired"))
  }
  if (ctx.isSupportSession) {
    throw new ChatbotXException(
      t("messengerPancakeCredential.errors.supportSession"),
      "messengerPancakeCredentialSupportSession",
      403,
    )
  }
}
