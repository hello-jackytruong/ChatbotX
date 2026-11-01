import { MessengerBackfillPage } from "@/features/messenger-backfill/components/messenger-backfill-page"
import { getMessengerBackfillPageData } from "@/features/messenger-backfill/queries/get-messenger-backfill-page-data.query"
import { resolveGuardedWorkspaceId } from "@/lib/auth/require-workspace-permission"

export default async function BackfillPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = await resolveGuardedWorkspaceId(params, "superAdmin")
  const data = await getMessengerBackfillPageData(workspaceId)

  return <MessengerBackfillPage {...data} workspaceId={workspaceId} />
}
