import type { BridgeEvent } from "@chatbotx.io/integration-zalo-personal/schema"

export type ZaloPersonalInboundCompletion = {
  messageId: string
  conversationId: string
  contactId: string
  direction: "inbound" | "outbound"
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

export const parseZaloPersonalInboundCompletion = (
  value: unknown,
): ZaloPersonalInboundCompletion | null => {
  const record = asRecord(value)
  if (
    typeof record?.messageId !== "string" ||
    typeof record.conversationId !== "string" ||
    typeof record.contactId !== "string" ||
    (record.direction !== "inbound" && record.direction !== "outbound")
  ) {
    return null
  }
  return {
    messageId: record.messageId,
    conversationId: record.conversationId,
    contactId: record.contactId,
    direction: record.direction,
  }
}

export const zaloPersonalProviderMessageId = (
  event: BridgeEvent,
): string | null => {
  const envelope = asRecord(event.payload)
  const payload = asRecord(envelope?.payload)
  const message = asRecord(payload?.message)
  for (const value of [
    event.providerEventId,
    message?.zaloMsgId,
    message?.id,
    payload?.messageId,
    payload?.msgId,
  ]) {
    if (typeof value === "string" && value.length > 0) {
      return value
    }
  }
  return null
}

export const buildZaloPersonalInboundMappings = (
  event: BridgeEvent,
  completion: ZaloPersonalInboundCompletion | null,
) => {
  if (!completion) {
    return null
  }
  const envelope = asRecord(event.payload)
  const payload = asRecord(envelope?.payload)
  const message = asRecord(payload?.message)
  const threadId =
    typeof payload?.conversationId === "string" ? payload.conversationId : null
  const senderId =
    typeof message?.senderUid === "string" ? message.senderUid : null
  const contactId = message?.senderType === "self" ? threadId : senderId
  const providerMessageId = zaloPersonalProviderMessageId(event)
  let providerClientId: string | null = null
  if (typeof message?.cliMsgId === "string") {
    providerClientId = message.cliMsgId
  } else if (typeof message?.clientMessageId === "string") {
    providerClientId = message.clientMessageId
  }
  if (!providerMessageId) {
    return null
  }
  const providerContactId = contactId ?? threadId
  return {
    thread: threadId
      ? { providerId: threadId, conversationId: completion.conversationId }
      : undefined,
    contact: providerContactId
      ? { providerId: providerContactId, contactId: completion.contactId }
      : undefined,
    message: {
      providerId: providerMessageId,
      providerClientId,
      messageId: completion.messageId,
      direction: completion.direction,
    },
  }
}
