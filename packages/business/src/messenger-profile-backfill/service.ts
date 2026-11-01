import { messengerProfileBackfillRunRepository } from "@chatbotx.io/database/repositories"
import type { MessengerProfileBackfillRunModel } from "@chatbotx.io/database/types"
import { ChatbotXException } from "../errors"
import { messengerIntegrationService } from "../integration-messenger/service"
import { messengerPancakeCredentialService } from "../messenger-pancake-credential/service"

export type MessengerProfileBackfillPolicy =
  MessengerProfileBackfillRunModel["policy"]

class MessengerProfileBackfillService {
  async schedule(input: {
    workspaceId: string
    integrationMessengerId: string
    requestedByUserId: string | null
    policy?: MessengerProfileBackfillPolicy
  }): Promise<{ runId: string }> {
    const integration = await messengerIntegrationService.findByIdForWorkspace({
      workspaceId: input.workspaceId,
      id: input.integrationMessengerId,
    })
    if (!integration) {
      throw new ChatbotXException(
        "Messenger Page not found in this workspace.",
        "messengerProfileBackfillPageNotFound",
        404,
      )
    }
    const policy = input.policy ?? "pancake"
    if (policy === "pancake") {
      const credential = await messengerPancakeCredentialService.getStatus({
        workspaceId: input.workspaceId,
        integrationMessengerId: input.integrationMessengerId,
      })
      if (!credential.configured) {
        throw new ChatbotXException(
          "Configure the Pancake token for this Page first.",
          "messengerProfileBackfillPancakeNotConfigured",
          400,
        )
      }
    }
    const run = await messengerProfileBackfillRunRepository.create({
      workspaceId: input.workspaceId,
      integrationMessengerId: input.integrationMessengerId,
      requestedByUserId: input.requestedByUserId,
      policy,
    })
    if (!run) {
      throw new ChatbotXException(
        "A profile backfill is already running for this Page.",
        "messengerProfileBackfillAlreadyRunning",
        409,
      )
    }
    return { runId: run.id }
  }

  async retry(input: {
    workspaceId: string
    runId: string
    requestedByUserId: string | null
  }) {
    const previous = await messengerProfileBackfillRunRepository.findById(input)
    if (
      !(
        previous && ["partial", "failed", "cancelled"].includes(previous.status)
      )
    ) {
      throw new ChatbotXException(
        "This profile backfill cannot be retried.",
        "messengerProfileBackfillRetryInvalid",
        400,
      )
    }
    return this.schedule({
      workspaceId: input.workspaceId,
      integrationMessengerId: previous.integrationMessengerId,
      requestedByUserId: input.requestedByUserId,
      policy: previous.policy,
    })
  }

  listHistory(input: { workspaceId: string; limit?: number }) {
    return messengerProfileBackfillRunRepository.listHistory(input)
  }

  claim(input: { workspaceId: string; runId: string }) {
    return messengerProfileBackfillRunRepository.claim(input)
  }

  findById(input: { workspaceId: string; runId: string }) {
    return messengerProfileBackfillRunRepository.findById(input)
  }

  requestCancel(input: { workspaceId: string; runId: string }) {
    return messengerProfileBackfillRunRepository.requestCancel(input)
  }

  finish(
    input: Parameters<typeof messengerProfileBackfillRunRepository.finish>[0],
  ) {
    return messengerProfileBackfillRunRepository.finish(input)
  }
}

export const messengerProfileBackfillService =
  new MessengerProfileBackfillService()
