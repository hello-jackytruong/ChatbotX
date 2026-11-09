import { BaseService } from "../base.service"
import { ZaloPersonalBridgeClient } from "./client"
import {
  BridgeMappingConflictError,
  type InboundBridgeCommit,
  type ZaloPersonalBridgeRepository,
  zaloPersonalBridgeRepository,
} from "./repository"

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    )
  }
  return value
}

async function digest(value: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(canonicalize(value))),
    ),
  )
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  )
}

export class ZaloPersonalBridgeService extends BaseService {
  private readonly repository: ZaloPersonalBridgeRepository
  private readonly createClient: (
    config: ConstructorParameters<typeof ZaloPersonalBridgeClient>[0],
  ) => Pick<
    ZaloPersonalBridgeClient,
    "acceptCommand" | "bindAccount" | "getCommand" | "reconcile"
  >

  constructor(
    repository: ZaloPersonalBridgeRepository = zaloPersonalBridgeRepository,
    createClient: (
      config: ConstructorParameters<typeof ZaloPersonalBridgeClient>[0],
    ) => Pick<
      ZaloPersonalBridgeClient,
      "acceptCommand" | "bindAccount" | "getCommand" | "reconcile"
    > = (config) => new ZaloPersonalBridgeClient(config),
  ) {
    super()
    this.repository = repository
    this.createClient = createClient
  }

  async enqueueOutbound(input: {
    workspaceId: string
    integrationId: string
    inboxId: string
    messageId: string
    accountId: string
    commandId: string
    payload: Record<string, unknown>
  }) {
    return await this.repository.createOutbound({
      ...input,
      idempotencyKey: input.messageId,
      payloadHash: await digest(input.payload),
    })
  }

  async commitInboundEvent(
    input: InboundBridgeCommit & { eventId: string; rawPayload: unknown },
  ): Promise<"committed" | "duplicate"> {
    try {
      return await this.repository.commitInbound(input)
    } catch (error) {
      if (error instanceof BridgeMappingConflictError) {
        await this.repository.addDeadLetter({
          workspaceId: input.workspaceId,
          integrationId: input.integrationId,
          inboxId: input.inboxId,
          accountId: input.accountId,
          direction: "inbound",
          eventId: input.eventId,
          errorCode: `MAPPING_CONFLICT_${error.mappingType.toUpperCase()}`,
          payloadDigest: await digest(input.rawPayload),
        })
      }
      throw error
    }
  }

  getOutbound(input: { workspaceId: string; commandId: string }) {
    return this.repository.getOutbound(input)
  }

  getCheckpoint(input: { integrationId: string; accountId: string }) {
    return this.repository.getCheckpoint(input)
  }

  async dispatchOutbound(input: {
    workspaceId: string
    integrationId: string
    inboxId: string
    messageId: string
    accountId: string
    bridgeUrl: string
    keyId: string
    secret: string
    command: Record<string, unknown> & { commandId: string }
  }): Promise<{ messageIds: string[]; sentCount: number }> {
    const row = await this.enqueueOutbound({
      workspaceId: input.workspaceId,
      integrationId: input.integrationId,
      inboxId: input.inboxId,
      messageId: input.messageId,
      accountId: input.accountId,
      commandId: input.command.commandId,
      payload: input.command,
    })
    if (row.status === "succeeded" && row.providerMessageId) {
      return { messageIds: [row.providerMessageId], sentCount: 1 }
    }
    const client = this.createClient({
      baseUrl: input.bridgeUrl,
      kid: input.keyId,
      secret: input.secret,
    })
    await client.bindAccount({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      inboxId: input.inboxId,
    })
    let response: Record<string, unknown>
    try {
      if (row.status === "unknown_outcome") {
        response = await client.reconcile({
          accountId: input.accountId,
          commandId: input.command.commandId,
        })
      } else if (row.attempts > 0) {
        response = await client.getCommand(input.command.commandId)
      } else {
        response = await client.acceptCommand(input.command)
      }
    } catch (error) {
      await this.repository.updateOutbound({
        id: row.id,
        workspaceId: input.workspaceId,
        status: "unknown_outcome",
        lastError:
          error instanceof Error ? error.message : "BRIDGE_UNAVAILABLE",
        incrementAttempts: true,
      })
      throw error
    }
    const result =
      response.result && typeof response.result === "object"
        ? (response.result as Record<string, unknown>)
        : null
    const providerIds =
      result?.providerIds && typeof result.providerIds === "object"
        ? (result.providerIds as Record<string, unknown>)
        : null
    let providerMessageId: string | null = null
    if (typeof providerIds?.messageId === "string") {
      providerMessageId = providerIds.messageId
    } else if (typeof response.providerMessageId === "string") {
      providerMessageId = response.providerMessageId
    }
    if (response.status === "succeeded" && providerMessageId) {
      await this.repository.updateOutbound({
        id: row.id,
        workspaceId: input.workspaceId,
        status: "succeeded",
        providerMessageId,
        lastError: null,
        incrementAttempts: row.attempts === 0,
      })
      return { messageIds: [providerMessageId], sentCount: 1 }
    }
    let status: "failed" | "pending" | "unknown_outcome" = "pending"
    if (response.status === "failed") {
      status = "failed"
    } else if (response.status === "unknown_outcome") {
      status = "unknown_outcome"
    }
    await this.repository.updateOutbound({
      id: row.id,
      workspaceId: input.workspaceId,
      status,
      lastError: `ZALO_PERSONAL_${status.toUpperCase()}`,
      incrementAttempts: row.attempts === 0,
    })
    throw new Error(`ZALO_PERSONAL_${status.toUpperCase()}`)
  }
}

export const zaloPersonalBridgeService = new ZaloPersonalBridgeService()
