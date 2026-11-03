import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  contactInboxFindByUncached: vi.fn(),
  conversationFindLatestByContact: vi.fn(),
  ensureContactAvatarMirrored: vi.fn(),
  queueWorkspaceRealtimeEvent: vi.fn(),
}))

vi.mock("@chatbotx.io/channel-registry/media-hydration", () => ({
  ensureContactAvatarMirrored: mocks.ensureContactAvatarMirrored,
}))

vi.mock("@chatbotx.io/business", () => ({
  contactInboxService: {
    findByUncached: mocks.contactInboxFindByUncached,
  },
  conversationService: {
    findLatestByContact: mocks.conversationFindLatestByContact,
  },
  queueWorkspaceRealtimeEvent: mocks.queueWorkspaceRealtimeEvent,
}))

vi.mock("@chatbotx.io/realtime-protocol", () => ({
  RealtimeEventType: { contactUpdated: "contactUpdated" },
  routeForConversation: (
    conversation: Record<string, unknown>,
    inboxId: string,
  ) => ({
    assignedTeamIds: conversation.assignedInboxTeamId
      ? [conversation.assignedInboxTeamId]
      : [],
    assignedUserIds: conversation.assignedUserId
      ? [conversation.assignedUserId]
      : [],
    inboxId,
  }),
}))

const { updateContactAvatar } = await import(
  "../src/integration/handlers/contact/update-avatar"
)

describe("updateContactAvatar", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ensureContactAvatarMirrored.mockResolvedValue(null)
    mocks.contactInboxFindByUncached.mockResolvedValue(undefined)
    mocks.conversationFindLatestByContact.mockResolvedValue(undefined)
  })

  test("delegates avatar hydration using the durable contact inbox lookup", async () => {
    await updateContactAvatar({
      workspaceId: "workspace-1",
      contactInboxId: "contact-inbox-1",
      sourceId: "legacy-queued-source-id",
    })

    expect(mocks.ensureContactAvatarMirrored).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      contactInboxId: "contact-inbox-1",
    })
  })

  test("broadcasts a routed contact patch after the avatar is mirrored", async () => {
    mocks.ensureContactAvatarMirrored.mockResolvedValue({
      avatar: "public/space/workspace-1/avatars/avatar-1",
    })
    mocks.contactInboxFindByUncached.mockResolvedValue({
      id: "contact-inbox-1",
      contactId: "contact-1",
      inboxId: "inbox-1",
    })
    mocks.conversationFindLatestByContact.mockResolvedValue({
      id: "conversation-1",
      assignedInboxTeamId: "team-1",
      assignedUserId: null,
    })

    await updateContactAvatar({
      workspaceId: "workspace-1",
      contactInboxId: "contact-inbox-1",
      sourceId: "psid-1",
    })

    expect(mocks.queueWorkspaceRealtimeEvent).toHaveBeenCalledWith(
      "workspace-1",
      {
        eventType: "contactUpdated",
        data: {
          contactId: "contact-1",
          changes: {
            avatar: "public/space/workspace-1/avatars/avatar-1",
          },
        },
        route: {
          assignedTeamIds: ["team-1"],
          assignedUserIds: [],
          inboxId: "inbox-1",
        },
      },
    )
  })
})
