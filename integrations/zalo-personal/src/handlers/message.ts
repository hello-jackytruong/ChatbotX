import { stepTypes } from "@chatbotx.io/flow-config"
import {
  contentTypes,
  type IncomingAttachment,
  type MessageHandlers,
  messageTypes,
  SdkException,
} from "@chatbotx.io/sdk"
import { ZaloPersonalBridgeClient } from "../bridge-client"
import {
  type BridgeEvent,
  bridgeEventSchema,
  type ZaloPersonalAuthValue,
} from "../schema/definition"

type OutgoingMessage = Parameters<
  MessageHandlers<ZaloPersonalAuthValue>["sendMessage"]
>[0]["data"]["message"]

type ProviderCommand = {
  version: 1
  commandId: string
  idempotencyKey: string
  accountId: string
  kind: "sendFile" | "sendImage" | "sendMessage" | "sendVideo" | "sendVoice"
  payload: { args: unknown[] }
  requestedAt: string
  deadlineAt: string
  traceId: string
}

const HTTP_URL_PATTERN = /^https?:\/\//i

export const handledFlowStepTypes = [
  stepTypes.enum.sendText,
  stepTypes.enum.sendImage,
  stepTypes.enum.sendVideo,
  stepTypes.enum.sendAudio,
  stepTypes.enum.sendFile,
] as const

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function extractMediaUrl(value: unknown): string | null {
  if (typeof value === "string" && HTTP_URL_PATTERN.test(value)) {
    return value
  }
  const record = asRecord(value)
  if (!record) {
    return null
  }
  for (const key of [
    "url",
    "hdUrl",
    "href",
    "normalUrl",
    "fileUrl",
    "thumbUrl",
  ]) {
    const candidate = record[key]
    if (typeof candidate === "string" && HTTP_URL_PATTERN.test(candidate)) {
      return candidate
    }
  }
  return null
}

function fileTypeForContentType(contentType: string) {
  if (contentType === "image" || contentType === "gif") {
    return "image" as const
  }
  if (contentType === "video") {
    return "video" as const
  }
  if (contentType === "voice" || contentType === "audio") {
    return "audio" as const
  }
  return "file" as const
}

function mimeTypeForFileType(fileType: IncomingAttachment["fileType"]): string {
  if (fileType === "image") {
    return "image/jpeg"
  }
  if (fileType === "video") {
    return "video/mp4"
  }
  if (fileType === "audio") {
    return "audio/mpeg"
  }
  return "application/octet-stream"
}

function legacyAttachments(
  message: Record<string, unknown>,
): IncomingAttachment[] {
  const values = Array.isArray(message.attachments) ? message.attachments : []
  const contentUrl = extractMediaUrl(message.content)
  const candidates = [...values, ...(contentUrl ? [contentUrl] : [])]
  return candidates.flatMap((value, index) => {
    const url = extractMediaUrl(value)
    if (!url) {
      return []
    }
    const contentType = textOf(message.contentType) ?? "file"
    const fileType = fileTypeForContentType(contentType)
    return [
      {
        sourceId: `${textOf(message.zaloMsgId) ?? textOf(message.id) ?? "media"}:${index}`,
        fileType,
        mimeType: mimeTypeForFileType(fileType),
        originPath: url,
        size: 0,
        url,
        isPhotoMessage: fileType === "image",
      } satisfies IncomingAttachment,
    ]
  })
}

export function parseInboundBridgeEvent(input: BridgeEvent) {
  const event = bridgeEventSchema.parse(input)
  const envelope = asRecord(event.payload)
  if (event.kind !== "message" || envelope?.event !== "chat:message") {
    return null
  }
  const socketPayload = asRecord(envelope.payload)
  const legacyMessage = asRecord(socketPayload?.message)
  if (!legacyMessage) {
    throw new SdkException("Invalid Zalo Personal message bridge payload")
  }
  const conversationId = textOf(socketPayload?.conversationId)
  const contactId =
    legacyMessage.senderType === "self"
      ? conversationId
      : (textOf(legacyMessage.senderUid) ?? conversationId)
  const providerMessageId =
    textOf(legacyMessage.zaloMsgId) ??
    event.providerEventId ??
    textOf(legacyMessage.id)
  if (!(contactId && providerMessageId)) {
    throw new SdkException("Zalo Personal message identity is missing")
  }
  const contentType = textOf(legacyMessage.contentType) ?? "text"
  const attachments = legacyAttachments(legacyMessage)
  return {
    message: {
      sourceId: providerMessageId,
      messageType:
        legacyMessage.senderType === "self"
          ? messageTypes.enum.outgoing
          : messageTypes.enum.incoming,
      text:
        contentType === "text"
          ? (textOf(legacyMessage.content) ?? undefined)
          : undefined,
      contentType: contentTypes.enum.text,
      attachments,
      contentAttributes: {
        bridgeEventId: event.eventId,
        bridgeSequence: event.accountSequence,
        fenceToken: event.fenceToken,
        zaloContentType: contentType,
      },
    },
    contact: {
      sourceId: contactId,
      firstName: textOf(legacyMessage.senderName) ?? undefined,
    },
    postbackAction: null,
    quickReplyAction: null,
    ref: null,
    occurredAt: new Date(event.occurredAt),
  }
}

function commandPayload(input: {
  contactId: string
  message: OutgoingMessage
}): Pick<ProviderCommand, "kind" | "payload"> {
  const attachments = input.message.attachments ?? []
  if (attachments.length === 0) {
    return {
      kind: "sendMessage",
      payload: {
        args: [input.contactId, 0, { msg: input.message.text ?? "" }],
      },
    }
  }
  const urls = attachments.map((attachment) => attachment.url).filter(Boolean)
  const kinds = new Set(attachments.map((attachment) => attachment.fileType))
  if (kinds.size !== 1 || urls.length !== attachments.length) {
    throw new SdkException(
      "Zalo Personal requires one supported media kind with public URLs per message",
    )
  }
  const kind = attachments[0]?.fileType
  if (kind === "image") {
    return {
      kind: "sendImage",
      payload: {
        args: [input.contactId, 0, urls, null, input.message.text ?? ""],
      },
    }
  }
  if (kind === "video" && urls.length === 1) {
    return {
      kind: "sendVideo",
      payload: { args: [input.contactId, 0, { videoPath: urls[0] }, null] },
    }
  }
  if (kind === "audio" && urls.length === 1) {
    return {
      kind: "sendVoice",
      payload: { args: [input.contactId, 0, urls[0]] },
    }
  }
  return {
    kind: "sendFile",
    payload: {
      args: [input.contactId, 0, urls, null, input.message.text ?? ""],
    },
  }
}

export function buildSendMessageCommand(input: {
  accountId: string
  contactId: string
  message: OutgoingMessage
  now?: Date
}): ProviderCommand {
  const now = input.now ?? new Date()
  const requestedAt = now.toISOString()
  const deadlineAt = new Date(now.getTime() + 30_000).toISOString()
  return {
    version: 1,
    commandId: input.message.id,
    idempotencyKey: input.message.id,
    accountId: input.accountId,
    ...commandPayload(input),
    requestedAt,
    deadlineAt,
    traceId: input.message.id,
  }
}

function buildFlowStepMessage(input: {
  messageId: string
  step: Record<string, unknown>
}): OutgoingMessage {
  let text: string | null = null
  if (typeof input.step.text === "string") {
    text = input.step.text
  } else if (typeof input.step.message === "string") {
    text = input.step.message
  }
  const url = typeof input.step.url === "string" ? input.step.url : null
  if (!(text || url)) {
    throw new SdkException(
      `Zalo Personal does not support flow step ${String(input.step.stepType)}`,
    )
  }
  const stepType = String(input.step.stepType).toLowerCase()
  let fileType: "audio" | "file" | "image" | "video" = "file"
  if (stepType.includes("image")) {
    fileType = "image"
  } else if (stepType.includes("video")) {
    fileType = "video"
  } else if (stepType.includes("audio")) {
    fileType = "audio"
  }
  return {
    id: input.messageId,
    workspaceId: "",
    conversationId: "",
    contentType: contentTypes.enum.text,
    messageType: messageTypes.enum.outgoing,
    text,
    ...(url
      ? {
          attachments: [
            {
              fileType,
              mimeType: "application/octet-stream",
              originPath: url,
              name: null,
              size: 0,
              url,
            },
          ],
        }
      : {}),
  }
}

export function buildSendFlowStepCommand(input: {
  accountId: string
  contactId: string
  messageId: string
  step: Record<string, unknown>
  now?: Date
}): ProviderCommand {
  return buildSendMessageCommand({
    accountId: input.accountId,
    contactId: input.contactId,
    message: buildFlowStepMessage(input),
    now: input.now,
  })
}

function providerMessageIds(payload: Record<string, unknown>): string[] {
  const result = asRecord(payload.result)
  const providerIds = asRecord(result?.providerIds)
  const messageId = textOf(providerIds?.messageId)
  return messageId ? [messageId] : []
}

export const sendMessage: MessageHandlers<ZaloPersonalAuthValue>["sendMessage"] =
  async ({ ctx, data }) => {
    const command = buildSendMessageCommand({
      accountId: ctx.auth.accountId,
      contactId: data.contact.sourceId,
      message: data.message,
    })
    const client = new ZaloPersonalBridgeClient({
      baseUrl: ctx.auth.bridgeUrl,
      keyId: ctx.auth.keyId,
      secret: ctx.auth.secret,
    })
    let status = await client.acceptCommand(command)
    for (
      let attempt = 0;
      attempt < 10 && status.status === "pending";
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      status = await client.getCommand(command.commandId)
    }
    const messageIds = providerMessageIds(status)
    if (status.status !== "succeeded" || messageIds.length === 0) {
      throw new SdkException(
        status.status === "unknown_outcome"
          ? "ZALO_PERSONAL_UNKNOWN_OUTCOME"
          : "ZALO_PERSONAL_SEND_PENDING",
      )
    }
    return { messageIds, sentCount: 1 }
  }

export const receiveMessage: MessageHandlers<ZaloPersonalAuthValue>["receiveMessage"] =
  async ({ data }) =>
    parseInboundBridgeEvent(bridgeEventSchema.parse(data.payload))

export const sendFlowStep: MessageHandlers<ZaloPersonalAuthValue>["sendFlowStep"] =
  async (props) => {
    const step = props.data.step as Record<string, unknown>
    const messageId = props.data.richResponse?.executionId
    if (!messageId) {
      throw new SdkException(
        "Zalo Personal flow sends require a stable execution identity",
      )
    }
    return await sendMessage({
      ctx: props.ctx,
      data: {
        contact: props.data.contact,
        message: buildFlowStepMessage({ messageId, step }),
        quickReplies: props.data.quickReplies,
      },
    })
  }

export const getMessageMediaUrls: MessageHandlers<ZaloPersonalAuthValue>["getMessageMediaUrls"] =
  async () => []

export const messageHandlers = {
  getMessageMediaUrls,
  receiveMessage,
  sendFlowStep,
  sendMessage,
}
