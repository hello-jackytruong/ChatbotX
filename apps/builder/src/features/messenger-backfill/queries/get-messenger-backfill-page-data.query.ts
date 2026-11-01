import {
  messengerBackfillService,
  messengerIntegrationService,
} from "@chatbotx.io/business"
import { sanitizePublicText } from "@chatbotx.io/business/errors"
import { messengerPancakeCredentialService } from "@chatbotx.io/business/messenger-pancake-credential"
import { messengerProfileBackfillService } from "@chatbotx.io/business/messenger-profile-backfill"
import { assertWorkspaceSuperAdmin } from "@/lib/auth/assert-workspace-super-admin"

export async function getMessengerBackfillPageData(workspaceId: string) {
  await assertWorkspaceSuperAdmin(workspaceId)

  const [integrations, history, profileRuns] = await Promise.all([
    messengerIntegrationService.listByWorkspaceIdOrId({ workspaceId }),
    messengerBackfillService.listHistory({ workspaceId, perPage: 50 }),
    messengerProfileBackfillService.listHistory({ workspaceId, limit: 30 }),
  ])

  const pages = await Promise.all(
    integrations.map(async ({ id, name, pageId }) => ({
      id,
      name,
      pageId,
      pancakeConfigured: (
        await messengerPancakeCredentialService.getStatus({
          workspaceId,
          integrationMessengerId: id,
        })
      ).configured,
    })),
  )

  return {
    pages,
    profileRuns: profileRuns.map((run) => ({
      id: run.id,
      integrationMessengerId: run.integrationMessengerId,
      policy: run.policy,
      status: run.status,
      currentScan: run.currentScan,
      updatedCount: run.updatedCount,
      avatarCount: run.avatarCount,
      skippedCount: run.skippedCount,
      failedCount: run.failedCount,
      currentError: run.currentError
        ? sanitizePublicText(run.currentError)
        : null,
      cancelRequestedAt: run.cancelRequestedAt,
      createdAt: run.createdAt,
    })),
    runs: history.data.map((run) => ({
      id: run.id,
      integrationId: run.integrationId,
      status: run.status,
      triggerSource: run.triggerSource,
      rangeFromAt: run.rangeFromAt,
      rangeToAt: run.rangeToAt,
      includeContacts: run.includeContacts,
      includeMessages: run.includeMessages,
      currentStep: run.currentStep,
      currentScan: run.currentScan,
      importedContactCount: run.importedContactCount,
      importedMessageCount: run.importedMessageCount,
      skippedCount: run.skippedCount,
      skippedUnavailableCount: run.skippedUnavailableCount,
      failedCount: run.failedCount,
      currentError: run.currentError
        ? sanitizePublicText(run.currentError)
        : null,
      cancelRequestedAt: run.cancelRequestedAt,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    })),
  }
}
