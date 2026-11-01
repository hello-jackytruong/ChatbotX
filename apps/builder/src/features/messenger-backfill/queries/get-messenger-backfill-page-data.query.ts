import {
  messengerBackfillService,
  messengerIntegrationService,
} from "@chatbotx.io/business"
import { sanitizePublicText } from "@chatbotx.io/business/errors"
import { assertWorkspaceSuperAdmin } from "@/lib/auth/assert-workspace-super-admin"

export async function getMessengerBackfillPageData(workspaceId: string) {
  await assertWorkspaceSuperAdmin(workspaceId)

  const [integrations, history] = await Promise.all([
    messengerIntegrationService.listByWorkspaceIdOrId({ workspaceId }),
    messengerBackfillService.listHistory({ workspaceId, perPage: 50 }),
  ])

  return {
    pages: integrations.map(({ id, name, pageId }) => ({ id, name, pageId })),
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
