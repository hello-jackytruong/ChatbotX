import {
  contactInboxService,
  contactService,
  conversationService,
  hasEmptyProfileName,
  inboxService,
  queueWorkspaceRealtimeEvent,
} from "@chatbotx.io/business"
import {
  RealtimeEventType,
  routeForConversation,
} from "@chatbotx.io/realtime-protocol"
import {
  LowJobAction,
  type LowJobMessengerProfileRefresh,
  lowQueue,
} from "@chatbotx.io/worker-config"
import { logger } from "../../lib/logger"
import { refreshExistingContactProfile } from "./contact-profile-refresh"

const INITIAL_REFRESH_DELAY_MS = 5000
const PROVIDER_RETRY_DELAY_MS = 310_000

export const enqueueMessengerProfileRefresh = (
  data: LowJobMessengerProfileRefresh["data"],
): void => {
  lowQueue
    .add(
      LowJobAction.messengerProfileRefresh,
      { type: LowJobAction.messengerProfileRefresh, data },
      {
        jobId: `messenger-profile-refresh-${data.contactInboxId}`,
        delay: INITIAL_REFRESH_DELAY_MS,
        attempts: 2,
        backoff: { type: "fixed", delay: PROVIDER_RETRY_DELAY_MS },
        removeOnComplete: true,
        removeOnFail: { count: 100 },
      },
    )
    .catch((error: unknown) => {
      logger.warn(
        { error, contactInboxId: data.contactInboxId },
        "Failed to enqueue deferred Messenger profile refresh",
      )
    })
}

/**
 * Runs after Pancake's eventually-consistent conversation index has had time
 * to observe the inbound message. An unavailable profile throws while the
 * contact is still nameless so BullMQ performs one bounded retry after the
 * normal five-minute provider cooldown.
 */
export const refreshMessengerContactProfile = async (
  data: LowJobMessengerProfileRefresh["data"],
): Promise<void> => {
  const contactInbox = await contactInboxService.findByUncached({
    where: { id: data.contactInboxId, contactId: data.contactId },
  })
  if (!contactInbox) {
    return
  }
  const inbox = await inboxService.findByIdOrFail({
    workspaceId: data.workspaceId,
    id: data.inboxId,
  })
  if (inbox.channel !== "messenger") {
    return
  }

  const refreshedContact = await refreshExistingContactProfile({
    source: "channelApi",
    inbox,
    contactInbox,
    incomingContact: { sourceId: contactInbox.sourceId },
    contactId: data.contactId,
    bypassCooldown: true,
    includeAvatar: true,
  })
  if (!refreshedContact) {
    const current = await contactService.findById({
      workspaceId: data.workspaceId,
      id: data.contactId,
    })
    if (current && hasEmptyProfileName(current)) {
      throw new Error("Messenger profile is not available yet")
    }
    return
  }

  const changes = {
    ...(refreshedContact.fullName
      ? { fullName: refreshedContact.fullName }
      : {}),
    ...(refreshedContact.avatar ? { avatar: refreshedContact.avatar } : {}),
  }
  if (Object.keys(changes).length === 0) {
    return
  }
  const conversation = await conversationService.findLatestByContact({
    contactId: data.contactId,
  })
  if (!conversation) {
    return
  }
  await queueWorkspaceRealtimeEvent(data.workspaceId, {
    eventType: RealtimeEventType.contactUpdated,
    data: { contactId: data.contactId, changes },
    route: routeForConversation(conversation, data.inboxId),
  })
}
