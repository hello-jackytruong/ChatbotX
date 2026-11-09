import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  acceptCommand: vi.fn(),
  attachProviderRuntime: vi.fn(),
  create: vi.fn(),
  createOrResumeQrSession: vi.fn(),
  decryptObject: vi.fn(),
  encryptObject: vi.fn(),
  findLatestInFlightByProvider: vi.fn(),
  initializeQrEventBaseline: vi.fn(),
  provisionAccount: vi.fn(),
  listEvents: vi.fn(),
  bindAccount: vi.fn(),
  cleanupOnboardingAccount: vi.fn(),
  updateQrState: vi.fn(),
  advanceProviderCursor: vi.fn(),
  fail: vi.fn(),
  completeProvisioned: vi.fn(),
  claimQrFinalization: vi.fn(),
  claimQrFailureCleanup: vi.fn(),
  claimQrCancellation: vi.fn(),
  claimQrExpiryCleanup: vi.fn(),
  failQrSession: vi.fn(),
  requireByIdForWorkspace: vi.fn(),
  requireByIdForWorkspaceAndActor: vi.fn(),
  cancelQrSession: vi.fn(),
  expireQrSession: vi.fn(),
  findConnection: vi.fn(),
  findConnectionById: vi.fn(),
  connectAndPersist: vi.fn(),
}))

vi.mock("@chatbotx.io/business/connect-session", () => ({
  connectSessionService: {
    attachProviderRuntime: mocks.attachProviderRuntime,
    create: mocks.create,
    createOrResumeQrSession: mocks.createOrResumeQrSession,
    findLatestInFlightByProvider: mocks.findLatestInFlightByProvider,
    initializeQrEventBaseline: mocks.initializeQrEventBaseline,
    updateQrState: mocks.updateQrState,
    advanceProviderCursor: mocks.advanceProviderCursor,
    fail: mocks.fail,
    completeProvisioned: mocks.completeProvisioned,
    claimQrFinalization: mocks.claimQrFinalization,
    claimQrFailureCleanup: mocks.claimQrFailureCleanup,
    claimQrCancellation: mocks.claimQrCancellation,
    claimQrExpiryCleanup: mocks.claimQrExpiryCleanup,
    failQrSession: mocks.failQrSession,
    requireByIdForWorkspace: mocks.requireByIdForWorkspace,
    requireByIdForWorkspaceAndActor: mocks.requireByIdForWorkspaceAndActor,
    cancelQrSession: mocks.cancelQrSession,
    expireQrSession: mocks.expireQrSession,
  },
}))

vi.mock("@chatbotx.io/business/connection", () => ({
  isActiveConnectionStatus: (status: string) => status === "connected",
  resolveOwnerId: vi.fn(async () => "owner-1"),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  connectionRepository: {
    findByProviderSourceId: mocks.findConnection,
    findByIdForWorkspace: mocks.findConnectionById,
  },
}))

vi.mock("../src/internal", () => ({
  connectAndPersist: mocks.connectAndPersist,
  resolveAdapter: () => ({
    provider: {
      describe: (auth: { accountId: string }) => ({
        sourceId: auth.accountId,
        displayName: `Zalo Personal ${auth.accountId}`,
      }),
    },
  }),
}))

vi.mock("@chatbotx.io/business/zalo-personal-bridge", () => ({
  ZaloPersonalBridgeHttpError: class extends Error {
    readonly status: number
    readonly code: string

    constructor(status: number, code: string) {
      super(code)
      this.status = status
      this.code = code
    }
  },
  ZaloPersonalBridgeClient: class {
    provisionAccount = mocks.provisionAccount
    acceptCommand = mocks.acceptCommand
    listEvents = mocks.listEvents
    bindAccount = mocks.bindAccount
    cleanupOnboardingAccount = mocks.cleanupOnboardingAccount
  },
}))

vi.mock("@chatbotx.io/encryption", () => ({
  encryptUtils: {
    decryptObject: mocks.decryptObject,
    encryptObject: mocks.encryptObject,
  },
}))

const {
  cancelConnectSession,
  expireZaloPersonalQrSession,
  mapZaloPersonalQrEvent,
  pollZaloPersonalQrSession,
  startZaloPersonalQrSession,
  startZaloPersonalQrReconnect,
} = await import("../src/zalo-personal-qr")
const { ZaloPersonalBridgeHttpError } = await import(
  "@chatbotx.io/business/zalo-personal-bridge"
)

const session = {
  id: "session-1",
  workspaceId: "workspace-1",
  provider: "zalo_personal",
  purpose: "connect",
  status: "pending",
  step: "prepare_qr",
  nextAction: {
    type: "display_qr",
    state: "preparing",
    retryable: true,
  },
  encryptedAuth: null,
  providerReference: null,
  providerCursor: null,
  providerFenceToken: null,
  createdAt: new Date("2026-11-09T00:00:00.000Z"),
  expiresAt: new Date("2026-11-09T00:10:00.000Z"),
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findLatestInFlightByProvider.mockResolvedValue(undefined)
  mocks.create.mockResolvedValue({ session, nonce: "nonce" })
  mocks.createOrResumeQrSession.mockResolvedValue(session)
  mocks.provisionAccount.mockResolvedValue({
    version: 1,
    accountId: "account-1",
    keyId: "account-kid",
    secret: "account-secret",
  })
  mocks.encryptObject.mockResolvedValue({ v: 1, text: "encrypted" })
  mocks.attachProviderRuntime.mockResolvedValue({
    ...session,
    providerReference: "account-1",
    encryptedAuth: { v: 1, text: "encrypted" },
  })
  mocks.initializeQrEventBaseline.mockImplementation(async (input) => ({
    ...session,
    providerReference: "account-1",
    encryptedAuth: { v: 1, text: "encrypted" },
    providerCursor: input.providerCursor,
  }))
  mocks.acceptCommand.mockResolvedValue({ status: "pending" })
  mocks.listEvents.mockResolvedValue({
    version: 1,
    accountId: "account-1",
    nextSequence: "0",
    highWaterMark: "0",
    retentionFloor: "0",
    events: [],
  })
  mocks.decryptObject.mockResolvedValue({
    authType: "custom",
    accountId: "account-1",
    bridgeUrl: "https://zalo.internal",
    keyId: "account-kid",
    secret: "account-secret",
    managedBy: "chatbotx_qr",
    connectSessionId: "session-1",
  })
  mocks.updateQrState.mockImplementation(async (input) => ({
    ...session,
    providerReference: "account-1",
    encryptedAuth: { v: 1, text: "encrypted" },
    providerCursor: input.providerCursor,
    providerFenceToken: input.providerFenceToken,
    nextAction: input.nextAction,
    step: input.step,
  }))
  mocks.claimQrCancellation.mockImplementation(async () => ({
    ...session,
    providerReference: "account-1",
    encryptedAuth: { v: 1, text: "encrypted" },
    step: "cleanup_cancelled",
  }))
  mocks.claimQrExpiryCleanup.mockImplementation(async () => ({
    ...session,
    providerReference: "account-1",
    encryptedAuth: { v: 1, text: "encrypted" },
    step: "cleanup_expired",
  }))
  mocks.cleanupOnboardingAccount.mockResolvedValue({ status: "cleaned" })
})

describe("cancelConnectSession", () => {
  it("retires the managed account before clearing the retryable local capability", async () => {
    const active = {
      ...session,
      providerReference: "account-1",
      encryptedAuth: { v: 1, text: "encrypted" },
    }
    mocks.requireByIdForWorkspaceAndActor.mockResolvedValue(active)
    mocks.cancelQrSession.mockResolvedValue({
      ...active,
      status: "cancelled",
      encryptedAuth: null,
    })

    await cancelConnectSession({
      id: "session-1",
      workspaceId: "workspace-1",
      actorUserId: "user-1",
    })

    expect(
      mocks.cleanupOnboardingAccount.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.cancelQrSession.mock.invocationCallOrder[0] as number)
    expect(mocks.cleanupOnboardingAccount).toHaveBeenCalledWith({
      accountId: "account-1",
      connectSessionId: "session-1",
    })
    expect(mocks.claimQrCancellation).toHaveBeenCalledWith({
      id: "session-1",
      workspaceId: "workspace-1",
      expectedStep: "prepare_qr",
    })
  })

  it("does not clean up an account already claimed for finalization", async () => {
    const finalizing = {
      ...session,
      providerReference: "account-1",
      encryptedAuth: { v: 1, text: "encrypted" },
      step: "finalizing",
    }
    mocks.requireByIdForWorkspaceAndActor.mockResolvedValue(finalizing)

    await expect(
      cancelConnectSession({
        id: "session-1",
        workspaceId: "workspace-1",
        actorUserId: "user-1",
      }),
    ).resolves.toBe(finalizing)

    expect(mocks.claimQrCancellation).not.toHaveBeenCalled()
    expect(mocks.cleanupOnboardingAccount).not.toHaveBeenCalled()
  })
})

describe("startZaloPersonalQrSession", () => {
  it("provisions server-side auth and enqueues loginWithQr with a stable identity", async () => {
    const result = await startZaloPersonalQrSession({
      workspaceId: "workspace-1",
      platformOwnerId: "owner-1",
      actorUserId: "user-1",
      provisioning: {
        bridgeUrl: "https://zalo.internal",
        kid: "provision-kid",
        secret: "provision-secret",
      },
    })

    expect(mocks.provisionAccount).toHaveBeenCalledWith({
      connectSessionId: "session-1",
      workspaceId: "workspace-1",
    })
    expect(mocks.encryptObject).toHaveBeenCalledWith(
      {
        authType: "custom",
        accountId: "account-1",
        bridgeUrl: "https://zalo.internal",
        keyId: "account-kid",
        secret: "account-secret",
        managedBy: "chatbotx_qr",
        connectSessionId: "session-1",
      },
      "connect-session:session-1:authorization",
    )
    expect(mocks.acceptCommand).toHaveBeenCalledWith({
      version: 1,
      commandId: "zalo-qr-login-session-1",
      idempotencyKey: "zalo-qr-login-session-1",
      accountId: "account-1",
      kind: "loginWithQr",
      payload: { args: [] },
      requestedAt: "2026-11-09T00:00:00.000Z",
      deadlineAt: "2026-11-09T00:10:00.000Z",
      traceId: "zalo-qr-login-session-1",
    })
    expect(mocks.initializeQrEventBaseline).toHaveBeenCalledWith({
      id: "session-1",
      workspaceId: "workspace-1",
      providerCursor: "0",
    })
    expect(
      mocks.initializeQrEventBaseline.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.acceptCommand.mock.invocationCallOrder[0] as number)
    expect(result.providerReference).toBe("account-1")
  })

  it("captures the existing account event high-water mark before reconnect login", async () => {
    mocks.listEvents.mockResolvedValueOnce({
      version: 1,
      accountId: "account-1",
      nextSequence: "1",
      highWaterMark: "42",
      retentionFloor: "1",
      events: [],
    })

    await startZaloPersonalQrReconnect({
      connectionId: "connection-1",
      workspaceId: "workspace-1",
      platformOwnerId: "owner-1",
      actorUserId: "user-1",
      auth: {
        authType: "custom",
        accountId: "account-1",
        bridgeUrl: "https://zalo.internal",
        keyId: "account-kid",
        secret: "account-secret",
      },
    })

    expect(mocks.initializeQrEventBaseline).toHaveBeenCalledWith({
      id: "session-1",
      workspaceId: "workspace-1",
      providerCursor: "42",
    })
    expect(
      mocks.initializeQrEventBaseline.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.acceptCommand.mock.invocationCallOrder[0] as number)
  })

  it("resumes an already-provisioned session without creating another account", async () => {
    const existing = {
      ...session,
      providerReference: "account-1",
      encryptedAuth: { v: 1, text: "encrypted" },
    }
    mocks.findLatestInFlightByProvider.mockResolvedValue(existing)
    mocks.createOrResumeQrSession.mockResolvedValue(existing)
    mocks.decryptObject.mockResolvedValue({
      authType: "custom",
      accountId: "account-1",
      bridgeUrl: "https://zalo.internal",
      keyId: "account-kid",
      secret: "account-secret",
    })

    await startZaloPersonalQrSession({
      workspaceId: "workspace-1",
      platformOwnerId: "owner-1",
      actorUserId: "user-1",
      provisioning: {
        bridgeUrl: "https://zalo.internal",
        kid: "provision-kid",
        secret: "provision-secret",
      },
    })

    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.provisionAccount).not.toHaveBeenCalled()
    expect(mocks.acceptCommand).toHaveBeenCalledTimes(1)
  })
})

describe("pollZaloPersonalQrSession", () => {
  const activeSession = {
    ...session,
    providerReference: "account-1",
    encryptedAuth: { v: 1, text: "encrypted" },
  }

  it("projects a durable QR event and checkpoints only after the state update", async () => {
    mocks.listEvents.mockResolvedValue({
      version: 1,
      accountId: "account-1",
      nextSequence: "7",
      highWaterMark: "7",
      retentionFloor: "1",
      events: [
        {
          version: 1,
          eventId: "event-7",
          accountId: "account-1",
          accountSequence: "7",
          fenceToken: "1",
          kind: "account_status",
          providerEventId: null,
          payload: {
            room: "account:account-1",
            event: "zalo:qr",
            payload: { accountId: "account-1", qrImage: "image" },
          },
          occurredAt: "2026-11-09T00:01:00.000Z",
        },
      ],
    })

    await pollZaloPersonalQrSession(activeSession as never)

    expect(mocks.updateQrState).toHaveBeenCalledWith({
      id: "session-1",
      workspaceId: "workspace-1",
      step: "scan_qr",
      providerCursor: "7",
      providerFenceToken: "1",
      expectedProviderCursor: null,
      expectedProviderFenceToken: null,
      nextAction: {
        type: "display_qr",
        state: "ready",
        qrImage: "image",
        retryable: true,
      },
    })
  })

  it("repairs binding and completes an already-persisted connection", async () => {
    const connection = {
      id: "connection-1",
      inboxId: "inbox-1",
      status: "connected",
      sourceId: "account-1",
    }
    mocks.findConnection.mockResolvedValue(connection)
    mocks.bindAccount.mockResolvedValue({ version: 1, status: "bound" })
    mocks.completeProvisioned.mockResolvedValue({
      ...activeSession,
      status: "completed",
      encryptedAuth: null,
    })
    mocks.claimQrFinalization.mockImplementation(async (input) => ({
      ...activeSession,
      step: "finalizing",
      providerCursor: input.providerCursor,
      providerFenceToken: input.providerFenceToken,
    }))
    mocks.listEvents.mockResolvedValue({
      version: 1,
      accountId: "account-1",
      nextSequence: "8",
      highWaterMark: "8",
      retentionFloor: "1",
      events: [
        {
          version: 1,
          eventId: "event-8",
          accountId: "account-1",
          accountSequence: "8",
          fenceToken: "1",
          kind: "account_status",
          providerEventId: null,
          payload: {
            room: "org:org-1",
            event: "zalo:connected",
            payload: { accountId: "account-1" },
          },
          occurredAt: "2026-11-09T00:02:00.000Z",
        },
      ],
    })

    await pollZaloPersonalQrSession(activeSession as never)

    expect(mocks.connectAndPersist).not.toHaveBeenCalled()
    expect(mocks.bindAccount).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      inboxId: "inbox-1",
    })
    expect(mocks.completeProvisioned).toHaveBeenCalledWith({
      id: "session-1",
      workspaceId: "workspace-1",
      connectionId: "connection-1",
    })
  })

  it("loads the winning connection when another worker finalizes concurrently", async () => {
    const connection = {
      id: "connection-1",
      inboxId: "inbox-1",
      status: "connected",
      sourceId: "account-1",
    }
    mocks.findConnection
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(connection)
    mocks.connectAndPersist.mockRejectedValueOnce({
      code: "connectionAlreadyConnected",
    })
    mocks.bindAccount.mockResolvedValue({ version: 1, status: "bound" })
    mocks.completeProvisioned.mockResolvedValue({
      ...activeSession,
      status: "completed",
      encryptedAuth: null,
    })
    mocks.claimQrFinalization.mockImplementation(async (input) => ({
      ...activeSession,
      step: "finalizing",
      providerCursor: input.providerCursor,
      providerFenceToken: input.providerFenceToken,
    }))
    mocks.listEvents.mockResolvedValue({
      version: 1,
      accountId: "account-1",
      nextSequence: "9",
      highWaterMark: "9",
      retentionFloor: "1",
      events: [
        {
          version: 1,
          eventId: "event-9",
          accountId: "account-1",
          accountSequence: "9",
          fenceToken: "1",
          kind: "account_status",
          providerEventId: null,
          payload: {
            room: "org:org-1",
            event: "zalo:connected",
            payload: { accountId: "account-1" },
          },
          occurredAt: "2026-11-09T00:03:00.000Z",
        },
      ],
    })

    await pollZaloPersonalQrSession(activeSession as never)

    expect(mocks.bindAccount).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      inboxId: "inbox-1",
    })
  })

  it("rejects an event from an older gateway fence", async () => {
    mocks.listEvents.mockResolvedValue({
      version: 1,
      accountId: "account-1",
      nextSequence: "10",
      highWaterMark: "10",
      retentionFloor: "1",
      events: [
        {
          version: 1,
          eventId: "event-10",
          accountId: "account-1",
          accountSequence: "10",
          fenceToken: "2",
          kind: "account_status",
          providerEventId: null,
          payload: {
            room: "account:account-1",
            event: "zalo:qr",
            payload: { accountId: "account-1", qrImage: "image" },
          },
          occurredAt: "2026-11-09T00:04:00.000Z",
        },
      ],
    })

    await expect(
      pollZaloPersonalQrSession({
        ...activeSession,
        providerFenceToken: "3",
      } as never),
    ).rejects.toThrow("ZALO_PERSONAL_QR_STALE_FENCE")
    expect(mocks.updateQrState).not.toHaveBeenCalled()
  })

  it("advances scanned to connecting on the following poll without inventing a provider event", async () => {
    const scannedSession = {
      ...activeSession,
      providerCursor: "11",
      providerFenceToken: "2",
      step: "confirming",
      nextAction: {
        type: "display_qr",
        state: "scanned",
        retryable: true,
      },
    }
    mocks.listEvents.mockResolvedValue({
      version: 1,
      accountId: "account-1",
      nextSequence: "11",
      highWaterMark: "11",
      retentionFloor: "1",
      events: [],
    })

    await pollZaloPersonalQrSession(scannedSession as never)

    expect(mocks.updateQrState).toHaveBeenCalledWith({
      id: "session-1",
      workspaceId: "workspace-1",
      step: "connecting",
      nextAction: {
        type: "display_qr",
        state: "connecting",
        retryable: true,
      },
      providerCursor: "11",
      providerFenceToken: "2",
      expectedProviderCursor: "11",
      expectedProviderFenceToken: "2",
    })
  })

  it("claims a failed event before destructive remote cleanup", async () => {
    const claimed = {
      ...activeSession,
      step: "cleanup_failed:provider_error",
      providerCursor: "13",
      providerFenceToken: "2",
    }
    mocks.claimQrFailureCleanup.mockResolvedValue(claimed)
    mocks.failQrSession.mockResolvedValue({
      ...claimed,
      status: "failed",
      encryptedAuth: null,
    })
    mocks.listEvents.mockResolvedValue({
      version: 1,
      accountId: "account-1",
      nextSequence: "13",
      highWaterMark: "13",
      retentionFloor: "1",
      events: [
        {
          version: 1,
          eventId: "event-13",
          accountId: "account-1",
          accountSequence: "13",
          fenceToken: "2",
          kind: "account_status",
          providerEventId: null,
          payload: {
            room: "account:account-1",
            event: "zalo:qr-session-dead",
            payload: { accountId: "account-1" },
          },
          occurredAt: "2026-11-09T00:05:00.000Z",
        },
      ],
    })

    await pollZaloPersonalQrSession(activeSession as never)

    expect(
      mocks.claimQrFailureCleanup.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.cleanupOnboardingAccount.mock.invocationCallOrder[0] as number,
    )
  })

  it("retries idempotent finalization after a worker crash consumed the connected event", async () => {
    const finalizingSession = {
      ...activeSession,
      step: "finalizing",
      providerCursor: "12",
      providerFenceToken: "2",
    }
    mocks.findConnection.mockResolvedValue({
      id: "connection-1",
      inboxId: "inbox-1",
      status: "connected",
      sourceId: "account-1",
    })
    mocks.completeProvisioned.mockResolvedValue({
      ...finalizingSession,
      status: "completed",
      encryptedAuth: null,
    })

    await pollZaloPersonalQrSession(finalizingSession as never)

    expect(mocks.listEvents).not.toHaveBeenCalled()
    expect(mocks.bindAccount).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      inboxId: "inbox-1",
    })
    expect(mocks.completeProvisioned).toHaveBeenCalledWith({
      id: "session-1",
      workspaceId: "workspace-1",
      connectionId: "connection-1",
    })
  })
})

describe("expireZaloPersonalQrSession", () => {
  it.each([
    ["cleanup_failed:provider_error", "failed"],
    ["cleanup_cancelled", "cancelled"],
  ])("resumes %s without reading events after remote cleanup revoked the key", async (step, terminalStatus) => {
    const claimed = {
      ...session,
      providerReference: "account-1",
      encryptedAuth: { v: 1, text: "encrypted" },
      providerCursor: "13",
      providerFenceToken: "2",
      step,
    }
    mocks.acceptCommand.mockRejectedValueOnce(
      new ZaloPersonalBridgeHttpError(401, "UNKNOWN_OR_REVOKED_KID"),
    )
    mocks.failQrSession.mockResolvedValue({
      ...claimed,
      status: "failed",
      encryptedAuth: null,
    })
    mocks.cancelQrSession.mockResolvedValue({
      ...claimed,
      status: "cancelled",
      encryptedAuth: null,
    })

    await expect(
      expireZaloPersonalQrSession(claimed as never),
    ).resolves.toMatchObject({ status: terminalStatus })

    expect(mocks.listEvents).not.toHaveBeenCalled()
    expect(mocks.cleanupOnboardingAccount).toHaveBeenCalledWith({
      accountId: "account-1",
      connectSessionId: "session-1",
    })
  })

  it("keeps expiry cleanup retryable by terminalizing only after remote retirement", async () => {
    const expired = {
      ...session,
      providerReference: "account-1",
      encryptedAuth: { v: 1, text: "encrypted" },
    }
    mocks.expireQrSession.mockResolvedValue({
      ...expired,
      status: "expired",
      encryptedAuth: null,
      nextAction: null,
    })

    await expireZaloPersonalQrSession(expired as never)

    expect(
      mocks.cleanupOnboardingAccount.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.expireQrSession.mock.invocationCallOrder[0] as number)
  })

  it("finalizes a connected event projected after the QR TTL instead of stranding cleanup", async () => {
    const expired = {
      ...session,
      providerReference: "account-1",
      encryptedAuth: { v: 1, text: "encrypted" },
    }
    const claimed = {
      ...expired,
      step: "finalizing",
      providerCursor: "14",
      providerFenceToken: "3",
    }
    mocks.listEvents.mockResolvedValue({
      version: 1,
      accountId: "account-1",
      nextSequence: "14",
      highWaterMark: "14",
      retentionFloor: "1",
      events: [
        {
          version: 1,
          eventId: "event-14",
          accountId: "account-1",
          accountSequence: "14",
          fenceToken: "3",
          kind: "account_status",
          providerEventId: null,
          payload: {
            room: "org:org-1",
            event: "zalo:connected",
            payload: { accountId: "account-1" },
          },
          occurredAt: "2026-11-09T00:10:01.000Z",
        },
      ],
    })
    mocks.claimQrFinalization.mockResolvedValue(claimed)
    mocks.findConnection.mockResolvedValue({
      id: "connection-1",
      inboxId: "inbox-1",
      status: "connected",
      sourceId: "account-1",
    })
    mocks.completeProvisioned.mockResolvedValue({
      ...claimed,
      status: "completed",
      encryptedAuth: null,
    })

    await expect(
      expireZaloPersonalQrSession(expired as never),
    ).resolves.toMatchObject({ status: "completed" })
    expect(mocks.claimQrExpiryCleanup).not.toHaveBeenCalled()
    expect(mocks.cleanupOnboardingAccount).not.toHaveBeenCalled()
  })

  it("continues session-bound cleanup when a response-loss retry finds the key revoked", async () => {
    const expired = {
      ...session,
      providerReference: "account-1",
      encryptedAuth: { v: 1, text: "encrypted" },
    }
    mocks.acceptCommand.mockRejectedValueOnce(
      new ZaloPersonalBridgeHttpError(401, "UNKNOWN_OR_REVOKED_KID"),
    )
    mocks.expireQrSession.mockResolvedValue({
      ...expired,
      status: "expired",
      encryptedAuth: null,
      nextAction: null,
    })

    await expect(
      expireZaloPersonalQrSession(expired as never),
    ).resolves.toMatchObject({ status: "expired" })
    expect(mocks.cleanupOnboardingAccount).toHaveBeenCalledWith({
      accountId: "account-1",
      connectSessionId: "session-1",
    })
  })
})

describe("mapZaloPersonalQrEvent", () => {
  it.each([
    [
      "zalo:qr",
      { accountId: "account-1", qrImage: "image" },
      {
        kind: "state",
        step: "scan_qr",
        nextAction: {
          type: "display_qr",
          state: "ready",
          qrImage: "image",
          retryable: true,
        },
      },
    ],
    [
      "zalo:scanned",
      { accountId: "account-1" },
      {
        kind: "state",
        step: "confirming",
        nextAction: {
          type: "display_qr",
          state: "scanned",
          retryable: true,
        },
      },
    ],
    [
      "zalo:qr-expired",
      { accountId: "account-1" },
      {
        kind: "state",
        step: "refresh_qr",
        nextAction: {
          type: "display_qr",
          state: "expired",
          retryable: true,
        },
      },
    ],
    [
      "zalo:qr",
      { accountId: "account-1", redacted: true },
      {
        kind: "state",
        step: "refresh_qr",
        nextAction: {
          type: "display_qr",
          state: "expired",
          retryable: true,
        },
      },
    ],
    ["zalo:connected", { accountId: "account-1" }, { kind: "connected" }],
    [
      "zalo:duplicate",
      { accountId: "account-1" },
      { kind: "failed", errorCode: "already_connected" },
    ],
    [
      "zalo:qr-session-dead",
      { accountId: "account-1" },
      { kind: "failed", errorCode: "provider_error" },
    ],
  ])("maps %s deterministically", (event, payload, expected) => {
    expect(
      mapZaloPersonalQrEvent({
        expectedAccountId: "account-1",
        envelope: { room: "account:account-1", event, payload },
      }),
    ).toEqual(expected)
  })

  it("rejects an account mismatch instead of updating another session", () => {
    expect(() =>
      mapZaloPersonalQrEvent({
        expectedAccountId: "account-1",
        envelope: {
          room: "account:account-2",
          event: "zalo:qr",
          payload: { accountId: "account-2", qrImage: "image" },
        },
      }),
    ).toThrow("ZALO_PERSONAL_QR_ACCOUNT_MISMATCH")
  })
})
