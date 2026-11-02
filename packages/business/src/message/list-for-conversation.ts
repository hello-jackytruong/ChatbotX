import {
  createMessageRepository,
  getSafeSinceTime,
  type MessageWithAttachments,
  type PaginationCursor,
} from "@chatbotx.io/database/repositories"
import { endOfHour } from "date-fns"
import { contactInboxService } from "../contact-inbox/service"
import { conversationService } from "../conversation/service"
import { notFoundException } from "../errors"
import { logger } from "../logger"
import {
  HYDRATION_CHANNELS,
  isFailedOriginPath,
  isStoredObjectPath,
  resolveAttachmentFallbackUrl,
  resolveAttachmentProxyUrl,
  resolveMediaUrl,
} from "../media"
import {
  resolveTenantSettings,
  resolveWorkspaceAppUrl,
} from "../platform/settings"
import { HTTP_URL_RE, toPublicStorageUrl } from "../utils"

const PUBLIC_OBJECT_PREFIX = "public/"

type PresignedAttachmentUrls = {
  url: string | null
  // Proxy URL to try when `url` fails to load; null when there is no recovery
  // path for this attachment.
  fallbackUrl: string | null
}

async function presignAttachments<T extends { id: string; originPath: string }>(
  attachments: T[],
  context: {
    channel: string
    workspaceId: string
    messageCreatedAt: Date
    storageUrl: string
  },
): Promise<Array<T & PresignedAttachmentUrls>> {
  const needsAppUrl = HYDRATION_CHANNELS.has(context.channel)
    ? attachments.some(
        (attachment) => !isFailedOriginPath(attachment.originPath),
      )
    : attachments.some(
        (attachment) =>
          isStoredObjectPath(attachment.originPath) &&
          !attachment.originPath.startsWith(PUBLIC_OBJECT_PREFIX),
      )
  let appUrlPromise: Promise<string> | undefined
  const resolveAppUrl = needsAppUrl
    ? () => {
        appUrlPromise ??= resolveWorkspaceAppUrl({
          workspaceId: context.workspaceId,
        })
        return appUrlPromise
      }
    : undefined

  return await Promise.all(
    attachments.map(async (attachment) => {
      const ref = {
        workspaceId: context.workspaceId,
        attachmentId: attachment.id,
        originPath: attachment.originPath,
        channel: context.channel,
        messageCreatedAt: context.messageCreatedAt,
        resolveAppUrl,
      }
      let url: string | null = null
      try {
        url = await resolveMediaUrl({ kind: "attachment", ...ref }, (key) => {
          if (HTTP_URL_RE.test(key)) {
            return key
          }
          if (key.startsWith(PUBLIC_OBJECT_PREFIX)) {
            return toPublicStorageUrl(key, context.storageUrl)
          }
          return resolveAttachmentProxyUrl(ref)
        })
      } catch (err) {
        // One unresolvable attachment (bad key, signer/host failure) must not
        // reject the whole page; drop just this attachment's URL.
        logger.warn(
          {
            err,
            attachmentId: attachment.id,
            workspaceId: context.workspaceId,
          },
          "Failed to resolve attachment media URL; omitting",
        )
      }
      let fallbackUrl: string | null = null
      try {
        fallbackUrl = await resolveAttachmentFallbackUrl(ref)
      } catch (err) {
        // The fallback is best-effort: losing it only costs the client its
        // recovery path, never the primary URL.
        logger.warn(
          {
            err,
            attachmentId: attachment.id,
            workspaceId: context.workspaceId,
          },
          "Failed to resolve attachment fallback URL; omitting",
        )
      }
      return { ...attachment, url, fallbackUrl }
    }),
  )
}

/**
 * Resolves a message's attachment URLs from data the caller already holds
 * (no DB read, no download): both a private stored object and a pending
 * (lazily-ingested) one get a signed app media proxy URL. Used wherever a message
 * is handed to a client directly, e.g. the realtime push of a new message.
 */
export async function withResolvedAttachmentUrls(
  message: MessageWithAttachments,
  context: { channel: string; workspaceId: string; storageUrl?: string },
): Promise<MessageWithPresignedAttachments> {
  const storageUrl =
    context.storageUrl ??
    (await resolveTenantSettings({ workspaceId: context.workspaceId }))
      .storageUrl
  return {
    ...message,
    attachments: await presignAttachments(message.attachments, {
      ...context,
      storageUrl,
      messageCreatedAt: message.createdAt,
    }),
  }
}

const loadContactInboxChannels = async (
  messages: readonly Pick<MessageWithAttachments, "contactInboxId">[],
  workspaceId: string,
): Promise<Map<string, string>> => {
  const contactInboxIds = [
    ...new Set(messages.map((message) => message.contactInboxId)),
  ]
  if (contactInboxIds.length === 0) {
    return new Map()
  }
  const contactInboxes = await contactInboxService.findManyByIds({
    workspaceId,
    ids: contactInboxIds,
  })
  return new Map(
    contactInboxes.map((contactInbox) => [
      contactInbox.id,
      contactInbox.channel,
    ]),
  )
}

export type ListForConversationInput = {
  workspaceId: string
  conversationId?: string
  contactInboxId?: string
  cursor?: PaginationCursor
  limit: number
}

export type MessageWithPresignedAttachments = Omit<
  MessageWithAttachments,
  "attachments"
> & {
  attachments: Array<
    MessageWithAttachments["attachments"][number] & PresignedAttachmentUrls
  >
}

export type ListForConversationResult = {
  data: MessageWithPresignedAttachments[]
  nextCursor: PaginationCursor | null
}

export async function listForConversation(
  input: ListForConversationInput,
): Promise<ListForConversationResult> {
  const [conversation, repository] = await Promise.all([
    input.conversationId
      ? conversationService.findBy({
          where: { id: input.conversationId, workspaceId: input.workspaceId },
        })
      : null,
    createMessageRepository(),
  ])

  let contactInbox: Awaited<
    ReturnType<typeof contactInboxService.findByUncached>
  > | null = null
  if (conversation) {
    contactInbox = input.contactInboxId
      ? await contactInboxService.findByUncached({
          where: {
            contactId: conversation.contactId,
            id: input.contactInboxId,
          },
        })
      : await contactInboxService.findRecentByContactId({
          workspaceId: input.workspaceId,
          contactId: conversation.contactId,
        })
  }

  const result = await repository.listByConversation({
    workspaceId: input.workspaceId,
    contactInboxId: input.contactInboxId,
    conversationId: input.conversationId,
    sinceTime: getSafeSinceTime(conversation?.createdAt),
    pagination: {
      limit: input.limit,
      cursor: input.cursor ?? {
        createdAt: endOfHour(contactInbox?.lastMessageAt ?? new Date()),
        id: "",
      },
    },
  })

  if (result.data.length === 0) {
    return { data: [], nextCursor: null }
  }

  const [{ storageUrl }, channelByContactInboxId] = await Promise.all([
    resolveTenantSettings({ workspaceId: input.workspaceId }),
    loadContactInboxChannels(result.data, input.workspaceId),
  ])
  const data = await Promise.all(
    result.data.map((message) =>
      withResolvedAttachmentUrls(message, {
        workspaceId: input.workspaceId,
        storageUrl,
        channel: channelByContactInboxId.get(message.contactInboxId) ?? "",
      }),
    ),
  )

  return { data, nextCursor: result.nextCursor }
}

export async function findForContact(input: {
  messageId: string
  conversationId: string
  workspaceId: string
}): Promise<MessageWithPresignedAttachments> {
  const { messageId, conversationId, workspaceId } = input
  const repository = await createMessageRepository()
  const conversation = await conversationService.findBy({
    where: { id: conversationId, workspaceId },
  })
  if (!conversation) {
    throw notFoundException("Message not found")
  }
  const message = await repository.findTriggerMessage({
    id: messageId,
    conversationId,
    workspaceId,
    sinceTime:
      getSafeSinceTime(conversation.createdAt) ?? conversation.createdAt,
    requireCompleteResults: true,
  })

  if (!message || message.conversationId !== conversationId) {
    throw notFoundException("Message not found")
  }
  const [{ storageUrl }, channelByContactInboxId] = await Promise.all([
    resolveTenantSettings({ workspaceId }),
    loadContactInboxChannels([message], workspaceId),
  ])

  return await withResolvedAttachmentUrls(message, {
    workspaceId,
    storageUrl,
    channel: channelByContactInboxId.get(message.contactInboxId) ?? "",
  })
}

export async function findByIdWithUrls(input: {
  workspaceId: string
  id: string
  createdAt: Date
}): Promise<MessageWithPresignedAttachments> {
  const repository = await createMessageRepository()
  const message = await repository.findById({
    id: input.id,
    createdAt: input.createdAt,
    workspaceId: input.workspaceId,
  })

  if (!message) {
    throw notFoundException("Message not found")
  }
  const [{ storageUrl }, channelByContactInboxId] = await Promise.all([
    resolveTenantSettings({ workspaceId: input.workspaceId }),
    loadContactInboxChannels([message], input.workspaceId),
  ])

  return await withResolvedAttachmentUrls(message, {
    workspaceId: input.workspaceId,
    storageUrl,
    channel: channelByContactInboxId.get(message.contactInboxId) ?? "",
  })
}
