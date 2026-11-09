import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const order: string[] = []
  return {
    order,
    bindAccount: vi.fn(() => {
      order.push("bind")
      return Promise.resolve({ status: "bound" })
    }),
    getCheckpoint: vi.fn(() => {
      order.push("checkpoint")
      return Promise.resolve(null)
    }),
    listActiveRuntimeRows: vi.fn(),
    listActiveQrSessions: vi.fn(async () => []),
    pollQrSession: vi.fn(),
    commitInboundEvent: vi.fn(),
    queueAdd: vi.fn(),
    waitForJobCompletion: vi.fn(),
    listEvents: vi.fn(() => {
      order.push("events")
      return Promise.resolve({
        version: 1,
        accountId: "account-1",
        nextSequence: "0",
        highWaterMark: "0",
        retentionFloor: "0",
        events: [],
      })
    }),
  }
})

vi.mock("../src/env", () => ({
  env: {
    ZALO_PERSONAL_BRIDGE_ENABLED: true,
    ZALO_PERSONAL_BRIDGE_POLL_ENABLED: true,
    ZALO_PERSONAL_BRIDGE_ACCOUNT_ALLOWLIST: "account-1",
    ZALO_PERSONAL_BRIDGE_ONBOARDING_ENABLED: true,
  },
}))

vi.mock("@chatbotx.io/business", () => ({
  withBlockedOwnerGuard: vi.fn(
    (_workspaceId: string, operation: () => Promise<void>) => operation(),
  ),
}))

vi.mock("@chatbotx.io/business/integration-zalo-personal", () => ({
  integrationZaloPersonalService: {
    listActiveRuntimeRows: mocks.listActiveRuntimeRows,
  },
}))

vi.mock("@chatbotx.io/business/connect-session", () => ({
  connectSessionService: {
    listActiveByProvider: mocks.listActiveQrSessions,
  },
}))

vi.mock("@chatbotx.io/connections/zalo-personal-qr", () => ({
  pollZaloPersonalQrSession: mocks.pollQrSession,
}))

vi.mock("@chatbotx.io/business/zalo-personal-bridge", () => ({
  ZaloPersonalBridgeClient: class {
    bindAccount = mocks.bindAccount
    listEvents = mocks.listEvents
  },
  zaloPersonalBridgeService: {
    getCheckpoint: mocks.getCheckpoint,
    commitInboundEvent: mocks.commitInboundEvent,
  },
}))

vi.mock("@chatbotx.io/worker-config", () => ({
  getQueueEvents: vi.fn(),
  IntegrationJobAction: {
    incomingMessage: "incomingMessage",
    messageStatus: "messageStatus",
    deleteIncomingMessage: "deleteIncomingMessage",
  },
  integrationQueue: { add: mocks.queueAdd },
  queueNames: { enum: { integration: "integration" } },
  waitForJobCompletionWithRetries: mocks.waitForJobCompletion,
}))

import { pollZaloPersonalBridge } from "../src/schedule/handlers/poll-zalo-personal-bridge"

describe("pollZaloPersonalBridge account binding", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.order.length = 0
    mocks.listActiveRuntimeRows.mockResolvedValue([
      {
        id: "integration-1",
        workspaceId: "workspace-1",
        inboxId: "inbox-1",
        accountId: "account-1",
        auth: {
          bridgeUrl: "https://bridge.internal",
          keyId: "kid-1",
          secret: "secret-1",
        },
      },
    ])
  })

  it("binds the provisioned mapping before reading its checkpoint or events", async () => {
    await pollZaloPersonalBridge()

    expect(mocks.bindAccount).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      inboxId: "inbox-1",
    })
    expect(mocks.listEvents).toHaveBeenCalledWith({
      accountId: "account-1",
      after: "0",
      limit: 100,
    })
    expect(mocks.order).toEqual(["bind", "checkpoint", "events"])
  })

  it("polls active QR sessions through the shared connection orchestrator", async () => {
    const session = {
      id: "session-1",
      workspaceId: "workspace-1",
      providerReference: "account-1",
    }
    mocks.listActiveQrSessions.mockResolvedValue([session])

    await pollZaloPersonalBridge()

    expect(mocks.pollQrSession).toHaveBeenCalledWith(session)
  })

  it("admits a managed QR account without adding it to the static allowlist", async () => {
    const session = {
      id: "session-2",
      workspaceId: "workspace-1",
      providerReference: "dynamic-account-2",
    }
    mocks.listActiveQrSessions.mockResolvedValue([session])

    await pollZaloPersonalBridge()

    expect(mocks.pollQrSession).toHaveBeenCalledWith(session)
  })

  it("continues existing account polling when one QR session fails", async () => {
    mocks.listActiveQrSessions.mockResolvedValue([
      {
        id: "session-1",
        workspaceId: "workspace-1",
        providerReference: "account-1",
      },
    ])
    mocks.pollQrSession.mockRejectedValueOnce(new Error("synthetic QR failure"))

    await expect(pollZaloPersonalBridge()).resolves.toBeUndefined()

    expect(mocks.bindAccount).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      inboxId: "inbox-1",
    })
    expect(mocks.listEvents).toHaveBeenCalled()
  })

  it("checkpoints an unsupported receipt and continues to the next message", async () => {
    mocks.queueAdd.mockResolvedValueOnce({ waitUntilFinished: vi.fn() })
    mocks.waitForJobCompletion.mockResolvedValueOnce({
      messageId: "chatbotx-message-8",
      conversationId: "conversation-1",
      contactId: "contact-1",
      direction: "inbound",
    })
    mocks.listEvents.mockImplementationOnce(() => {
      mocks.order.push("events")
      return Promise.resolve({
        version: 1,
        accountId: "account-1",
        nextSequence: "9",
        highWaterMark: "8",
        retentionFloor: "1",
        events: [
          {
            version: 1,
            eventId: "event-delivered-7",
            accountId: "account-1",
            accountSequence: "7",
            fenceToken: "3",
            kind: "delivered",
            providerEventId: "provider-message-1",
            payload: {},
            occurredAt: "2026-11-09T14:00:00.000Z",
          },
          {
            version: 1,
            eventId: "event-message-8",
            accountId: "account-1",
            accountSequence: "8",
            fenceToken: "3",
            kind: "message",
            providerEventId: "provider-message-2",
            payload: {
              event: "chat:message",
              payload: {
                conversationId: "thread-1",
                message: {
                  senderType: "user",
                  senderUid: "provider-contact-1",
                  zaloMsgId: "provider-message-2",
                },
              },
            },
            occurredAt: "2026-11-09T14:00:01.000Z",
          },
        ],
      })
    })

    await pollZaloPersonalBridge()

    expect(mocks.queueAdd).toHaveBeenCalledTimes(1)
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "incomingMessage",
      expect.objectContaining({
        type: "incomingMessage",
        data: expect.objectContaining({
          integrationType: "zalo_personal",
          integrationIdentifier: "account-1",
        }),
      }),
      { jobId: "zalo-personal-event-event-message-8" },
    )
    expect(mocks.commitInboundEvent).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      integrationId: "integration-1",
      inboxId: "inbox-1",
      accountId: "account-1",
      sequence: "7",
      fenceToken: "3",
      eventId: "event-delivered-7",
      rawPayload: {},
    })
    expect(mocks.commitInboundEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sequence: "8",
        eventId: "event-message-8",
        message: {
          providerId: "provider-message-2",
          providerClientId: null,
          messageId: "chatbotx-message-8",
          direction: "inbound",
        },
      }),
    )
  })
})
