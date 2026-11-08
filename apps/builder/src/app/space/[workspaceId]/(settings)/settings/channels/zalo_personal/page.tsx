import { integrationZaloPersonalService } from "@chatbotx.io/business/integration-zalo-personal"
import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { ZaloPersonalManage } from "@/features/integration-zalo-personal/components/zalo-personal-manage"
import { requireVisibleChannel } from "@/lib/workspace/require-visible-channel"
import { resolveChannelCreatable } from "@/lib/workspace/resolve-channel-creatable"

export default async function SettingChannelZaloPersonalPage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  await requireVisibleChannel(workspaceId, "zalo_personal")
  const [integrations, canCreate] = await Promise.all([
    integrationZaloPersonalService.listByWorkspaceId(workspaceId),
    resolveChannelCreatable(workspaceId, "zalo_personal"),
  ])
  return (
    <ZaloPersonalManage
      canCreate={canCreate}
      integrations={integrations}
      workspaceId={workspaceId}
    />
  )
}
