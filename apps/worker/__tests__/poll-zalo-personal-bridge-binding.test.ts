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
    commitInboundEvent: vi.fn(),
  },
}))

vi.mock("@chatbotx.io/worker-config", () => ({
  getQueueEvents: vi.fn(),
  IntegrationJobAction: {
    incomingMessage: "incomingMessage",
    messageStatus: "messageStatus",
    deleteIncomingMessage: "deleteIncomingMessage",
  },
  integrationQueue: { add: vi.fn() },
  queueNames: { enum: { integration: "integration" } },
  waitForJobCompletionWithRetries: vi.fn(),
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
})
