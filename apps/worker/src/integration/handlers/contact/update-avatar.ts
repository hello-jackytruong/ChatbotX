import {
  contactInboxService,
  conversationService,
  queueWorkspaceRealtimeEvent,
} from "@chatbotx.io/business"
import { ensureContactAvatarMirrored } from "@chatbotx.io/channel-registry/media-hydration"
import {
  RealtimeEventType,
  routeForConversation,
} from "@chatbotx.io/realtime-protocol"
import type { LowJobUpdateContactAvatar } from "@chatbotx.io/worker-config"

export const updateContactAvatar = async (
  data: LowJobUpdateContactAvatar["data"],
): Promise<void> => {
  const mirrored = await ensureContactAvatarMirrored({
    contactInboxId: data.contactInboxId,
    workspaceId: data.workspaceId,
  })
  if (!mirrored) {
    return
  }

  const contactInbox = await contactInboxService.findByUncached({
    where: { id: data.contactInboxId },
  })
  if (!contactInbox) {
    return
  }
  const conversation = await conversationService.findLatestByContact({
    contactId: contactInbox.contactId,
  })
  if (!conversation) {
    return
  }

  await queueWorkspaceRealtimeEvent(data.workspaceId, {
    eventType: RealtimeEventType.contactUpdated,
    data: {
      contactId: contactInbox.contactId,
      changes: { avatar: mirrored.avatar },
    },
    route: routeForConversation(conversation, contactInbox.inboxId),
  })
}
