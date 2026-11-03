import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  contactInboxFindByUncached: vi.fn(),
  contactFindById: vi.fn(),
  conversationFindLatestByContact: vi.fn(),
  inboxFindByIdOrFail: vi.fn(),
  lowQueueAdd: vi.fn(),
  queueWorkspaceRealtimeEvent: vi.fn(),
  refreshExistingContactProfile: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  contactInboxService: {
    findByUncached: mocks.contactInboxFindByUncached,
  },
  contactService: { findById: mocks.contactFindById },
  conversationService: {
    findLatestByContact: mocks.conversationFindLatestByContact,
  },
  hasEmptyProfileName: (contact: {
    firstName?: string | null
    lastName?: string | null
  }) => !(contact.firstName?.trim() || contact.lastName?.trim()),
  inboxService: { findByIdOrFail: mocks.inboxFindByIdOrFail },
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

vi.mock("@chatbotx.io/worker-config", () => ({
  LowJobAction: { messengerProfileRefresh: "messengerProfileRefresh" },
  lowQueue: { add: mocks.lowQueueAdd },
}))

vi.mock("../src/lib/logger", () => ({
  logger: { warn: vi.fn() },
}))

vi.mock("../src/integration/handlers/contact-profile-refresh", () => ({
  refreshExistingContactProfile: mocks.refreshExistingContactProfile,
}))

const { enqueueMessengerProfileRefresh, refreshMessengerContactProfile } =
  await import("../src/integration/handlers/messenger-profile-refresh")

const data = {
  workspaceId: "workspace-1",
  inboxId: "inbox-1",
  contactInboxId: "contact-inbox-1",
  contactId: "contact-1",
}

describe("deferred Messenger profile refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.lowQueueAdd.mockResolvedValue(undefined)
    mocks.contactInboxFindByUncached.mockResolvedValue({
      id: "contact-inbox-1",
      contactId: "contact-1",
      inboxId: "inbox-1",
      sourceId: "psid-1",
      channel: "messenger",
    })
    mocks.inboxFindByIdOrFail.mockResolvedValue({
      id: "inbox-1",
      workspaceId: "workspace-1",
      channel: "messenger",
    })
    mocks.conversationFindLatestByContact.mockResolvedValue({
      id: "conversation-1",
      assignedInboxTeamId: "team-1",
      assignedUserId: null,
    })
  })

  test("enqueues one delayed, bounded retry job per contact inbox", () => {
    enqueueMessengerProfileRefresh(data)

    expect(mocks.lowQueueAdd).toHaveBeenCalledWith(
      "messengerProfileRefresh",
      { type: "messengerProfileRefresh", data },
      {
        jobId: "messenger-profile-refresh-contact-inbox-1",
        delay: 5000,
        attempts: 2,
        backoff: { type: "fixed", delay: 310_000 },
        removeOnComplete: true,
        removeOnFail: { count: 100 },
      },
    )
  })

  test("broadcasts the name and avatar after the delayed provider refresh", async () => {
    mocks.refreshExistingContactProfile.mockResolvedValue({
      id: "contact-1",
      fullName: "Nguyen Van A",
      avatar: "public/space/workspace-1/avatars/avatar-1",
    })

    await refreshMessengerContactProfile(data)

    expect(mocks.refreshExistingContactProfile).toHaveBeenCalledWith(
      expect.objectContaining({ bypassCooldown: true, includeAvatar: true }),
    )
    expect(mocks.queueWorkspaceRealtimeEvent).toHaveBeenCalledWith(
      "workspace-1",
      {
        eventType: "contactUpdated",
        data: {
          contactId: "contact-1",
          changes: {
            fullName: "Nguyen Van A",
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

  test("throws while the contact is still nameless so BullMQ retries", async () => {
    mocks.refreshExistingContactProfile.mockResolvedValue(undefined)
    mocks.contactFindById.mockResolvedValue({
      id: "contact-1",
      firstName: null,
      lastName: null,
    })

    await expect(refreshMessengerContactProfile(data)).rejects.toThrow(
      "Messenger profile is not available yet",
    )
  })
})
