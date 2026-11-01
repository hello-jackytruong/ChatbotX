import type { EncryptedData } from "@chatbotx.io/encryption"
import { and, type DatabaseClient, db, eq } from "../../client"
import { messengerPancakeCredentialModel } from "../../schema"
import type { MessengerPancakeCredentialModel } from "../../types"

export type MessengerPancakeCredentialRef = {
  workspaceId: string
  integrationMessengerId: string
}

export type MessengerPancakeCredentialStatusRow = Pick<
  MessengerPancakeCredentialModel,
  | "id"
  | "workspaceId"
  | "integrationMessengerId"
  | "verifiedAt"
  | "updatedAt"
  | "updatedByUserId"
>

export type MessengerPancakeCredentialEncryptedRow = Pick<
  MessengerPancakeCredentialModel,
  "id" | "workspaceId" | "integrationMessengerId" | "encryptedToken"
>

export type UpsertMessengerPancakeCredentialInput =
  MessengerPancakeCredentialRef & {
    encryptedToken: EncryptedData
    verifiedAt: Date
    updatedByUserId: string | null
  }

const credentialWhere = (input: MessengerPancakeCredentialRef) =>
  and(
    eq(messengerPancakeCredentialModel.workspaceId, input.workspaceId),
    eq(
      messengerPancakeCredentialModel.integrationMessengerId,
      input.integrationMessengerId,
    ),
  )

export const messengerPancakeCredentialRepository = {
  async findStatus(
    input: MessengerPancakeCredentialRef,
    tx: DatabaseClient = db,
  ): Promise<MessengerPancakeCredentialStatusRow | null> {
    const [row] = await tx
      .select({
        id: messengerPancakeCredentialModel.id,
        workspaceId: messengerPancakeCredentialModel.workspaceId,
        integrationMessengerId:
          messengerPancakeCredentialModel.integrationMessengerId,
        verifiedAt: messengerPancakeCredentialModel.verifiedAt,
        updatedAt: messengerPancakeCredentialModel.updatedAt,
        updatedByUserId: messengerPancakeCredentialModel.updatedByUserId,
      })
      .from(messengerPancakeCredentialModel)
      .where(credentialWhere(input))
      .limit(1)

    return row ?? null
  },

  /** Internal secret projection. Callers must keep plaintext in-process only. */
  async findEncryptedForBackend(
    input: MessengerPancakeCredentialRef,
    tx: DatabaseClient = db,
  ): Promise<MessengerPancakeCredentialEncryptedRow | null> {
    const [row] = await tx
      .select({
        id: messengerPancakeCredentialModel.id,
        workspaceId: messengerPancakeCredentialModel.workspaceId,
        integrationMessengerId:
          messengerPancakeCredentialModel.integrationMessengerId,
        encryptedToken: messengerPancakeCredentialModel.encryptedToken,
      })
      .from(messengerPancakeCredentialModel)
      .where(credentialWhere(input))
      .limit(1)

    return row ?? null
  },

  async upsert(
    input: UpsertMessengerPancakeCredentialInput,
    tx: DatabaseClient = db,
  ): Promise<MessengerPancakeCredentialStatusRow> {
    const { workspaceId, integrationMessengerId, ...credential } = input
    const [row] = await tx
      .insert(messengerPancakeCredentialModel)
      .values({ workspaceId, integrationMessengerId, ...credential })
      .onConflictDoUpdate({
        target: messengerPancakeCredentialModel.integrationMessengerId,
        set: credential,
      })
      .returning({
        id: messengerPancakeCredentialModel.id,
        workspaceId: messengerPancakeCredentialModel.workspaceId,
        integrationMessengerId:
          messengerPancakeCredentialModel.integrationMessengerId,
        verifiedAt: messengerPancakeCredentialModel.verifiedAt,
        updatedAt: messengerPancakeCredentialModel.updatedAt,
        updatedByUserId: messengerPancakeCredentialModel.updatedByUserId,
      })

    if (!row) {
      throw new Error("Failed to save Pancake Page credential")
    }
    return row
  },

  async delete(
    input: MessengerPancakeCredentialRef,
    tx: DatabaseClient = db,
  ): Promise<boolean> {
    const rows = await tx
      .delete(messengerPancakeCredentialModel)
      .where(credentialWhere(input))
      .returning({ id: messengerPancakeCredentialModel.id })
    return rows.length > 0
  },
}
