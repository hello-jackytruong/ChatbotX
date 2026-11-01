import {
  type MessengerPancakeCredentialRef,
  type MessengerPancakeCredentialStatusRow,
  messengerPancakeCredentialRepository,
} from "@chatbotx.io/database/repositories"
import { encryptUtils } from "@chatbotx.io/encryption"
import { notFoundException } from "../errors"
import { messengerIntegrationService } from "../integration-messenger/service"
import { verifyPancakePageToken } from "./client"

export type MessengerPancakeCredentialStatus =
  | { configured: false }
  | {
      configured: true
      verifiedAt: Date
      updatedAt: Date
      updatedByUserId: string | null
    }

const credentialAad = (input: MessengerPancakeCredentialRef) =>
  `messenger-pancake:${input.workspaceId}:${input.integrationMessengerId}`

const toStatus = (
  row: MessengerPancakeCredentialStatusRow | null,
): MessengerPancakeCredentialStatus =>
  row
    ? {
        configured: true,
        verifiedAt: row.verifiedAt,
        updatedAt: row.updatedAt,
        updatedByUserId: row.updatedByUserId,
      }
    : { configured: false }

class MessengerPancakeCredentialService {
  async getStatus(
    input: MessengerPancakeCredentialRef,
  ): Promise<MessengerPancakeCredentialStatus> {
    return toStatus(
      await messengerPancakeCredentialRepository.findStatus(input),
    )
  }

  async verifyAndReplace(
    input: MessengerPancakeCredentialRef & {
      token: string
      updatedByUserId: string | null
    },
  ): Promise<MessengerPancakeCredentialStatus> {
    const integration = await messengerIntegrationService.findByIdForWorkspace({
      id: input.integrationMessengerId,
      workspaceId: input.workspaceId,
    })
    if (!integration) {
      throw notFoundException("Messenger integration not found")
    }

    // Verification is deliberately before encryption/upsert. A bad replacement
    // leaves the previous known-good credential untouched.
    await verifyPancakePageToken({
      pageId: integration.pageId,
      token: input.token,
    })
    const encryptedToken = await encryptUtils.encryptText(
      input.token,
      credentialAad(input),
    )
    const row = await messengerPancakeCredentialRepository.upsert({
      workspaceId: input.workspaceId,
      integrationMessengerId: input.integrationMessengerId,
      encryptedToken,
      verifiedAt: new Date(),
      updatedByUserId: input.updatedByUserId,
    })
    return toStatus(row)
  }

  delete(input: MessengerPancakeCredentialRef): Promise<boolean> {
    return messengerPancakeCredentialRepository.delete(input)
  }

  async withToken<T>(
    input: MessengerPancakeCredentialRef,
    use: (token: string) => Promise<T>,
  ): Promise<T | undefined> {
    const row =
      await messengerPancakeCredentialRepository.findEncryptedForBackend(input)
    if (!row) {
      return
    }
    const token = await encryptUtils.decryptText(
      row.encryptedToken,
      credentialAad(input),
    )
    return await use(token)
  }
}

export const messengerPancakeCredentialService =
  new MessengerPancakeCredentialService()
