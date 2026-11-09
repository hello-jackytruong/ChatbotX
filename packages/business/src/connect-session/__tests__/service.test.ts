import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  transactionClient: { execute: vi.fn() },
  countActiveByWorkspaceId: vi.fn(async () => 0),
  insert: vi.fn(),
  update: vi.fn(),
  findById: vi.fn(),
  findByIdForWorkspace: vi.fn(),
  findByStateNonceHash: vi.fn(),
  claimTarget: vi.fn(),
  releaseTarget: vi.fn(),
  appendResults: vi.fn(),
  completeReconnect: vi.fn(),
  completeProvisioned: vi.fn(),
  listActiveByProvider: vi.fn(async () => []),
  listExpiredByProviderWithRuntime: vi.fn(async () => []),
  findLatestInFlightByProvider: vi.fn(),
  findLatestInFlightByTargetConnection: vi.fn(),
  updateWhereStatusIn: vi.fn(),
  cancelPendingByProvider: vi.fn(async () => 0),
  expireDue: vi.fn(async () => 0),
  purgeOldTerminal: vi.fn(
    async (): Promise<{
      deleted: number
      stopReason: "drained" | "deadline" | "chunkCap"
    }> => ({
      deleted: 0,
      stopReason: "drained",
    }),
  ),
}))

vi.mock("@chatbotx.io/database/client", () => ({
  db: {
    transaction: (
      operation: (tx: typeof mocks.transactionClient) => Promise<unknown>,
    ) => operation(mocks.transactionClient),
  },
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  connectSessionRepository: {
    countActiveByWorkspaceId: mocks.countActiveByWorkspaceId,
    insert: mocks.insert,
    update: mocks.update,
    findById: mocks.findById,
    findByIdForWorkspace: mocks.findByIdForWorkspace,
    findByStateNonceHash: mocks.findByStateNonceHash,
    claimTarget: mocks.claimTarget,
    releaseTarget: mocks.releaseTarget,
    appendResults: mocks.appendResults,
    completeReconnect: mocks.completeReconnect,
    completeProvisioned: mocks.completeProvisioned,
    listActiveByProvider: mocks.listActiveByProvider,
    listExpiredByProviderWithRuntime: mocks.listExpiredByProviderWithRuntime,
    findLatestInFlightByProvider: mocks.findLatestInFlightByProvider,
    findLatestInFlightByTargetConnection:
      mocks.findLatestInFlightByTargetConnection,
    updateWhereStatusIn: mocks.updateWhereStatusIn,
    cancelPendingByProvider: mocks.cancelPendingByProvider,
    expireDue: mocks.expireDue,
    purgeOldTerminal: mocks.purgeOldTerminal,
  },
}))

const { connectSessionService } = await import("../service")

const FUTURE = new Date(Date.now() + 60_000)
const PAST = new Date(Date.now() - 60_000)

const baseSession = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "session-1",
  workspaceId: "ws-1",
  provider: "messenger",
  status: "pending",
  expiresAt: FUTURE,
  targets: [],
  results: [],
  resultConnectionIds: [],
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.countActiveByWorkspaceId.mockResolvedValue(0)
  mocks.findLatestInFlightByProvider.mockResolvedValue(undefined)
  mocks.findLatestInFlightByTargetConnection.mockResolvedValue(undefined)
  mocks.update.mockImplementation(
    async (input: { id: string; values: Record<string, unknown> }) => ({
      ...baseSession(),
      id: input.id,
      ...input.values,
    }),
  )
  mocks.updateWhereStatusIn.mockImplementation(
    async (input: { id: string; values: Record<string, unknown> }) => ({
      ...baseSession(),
      id: input.id,
      ...input.values,
    }),
  )
  mocks.findById.mockResolvedValue(baseSession())
  mocks.completeReconnect.mockImplementation(
    async (input: { id: string; result: Record<string, unknown> }) =>
      baseSession({
        id: input.id,
        status: "completed",
        results: [input.result],
      }),
  )
  mocks.completeProvisioned.mockImplementation(
    async (input: { id: string; connectionId: string }) =>
      baseSession({
        id: input.id,
        status: "completed",
        resultConnectionIds: [input.connectionId],
      }),
  )
})

describe("connectSessionService QR provider lifecycle", () => {
  it("serializes QR resume by workspace, provider and actor", async () => {
    const existing = baseSession({
      provider: "zalo_personal",
      actorUserId: null,
      actorTokenId: "token-a",
    })
    mocks.findLatestInFlightByProvider.mockResolvedValue(existing)

    await expect(
      connectSessionService.createOrResumeQrSession({
        workspaceId: "ws-1",
        provider: "zalo_personal",
        purpose: "connect",
        platformOwnerId: "owner-1",
        actorTokenId: "token-a",
      }),
    ).resolves.toBe(existing)

    expect(mocks.transactionClient.execute).toHaveBeenCalledOnce()
    expect(mocks.findLatestInFlightByProvider).toHaveBeenCalledWith(
      {
        workspaceId: "ws-1",
        provider: "zalo_personal",
        actorTokenId: "token-a",
      },
      mocks.transactionClient,
    )
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it("hides a token-owned session from another token in the same workspace", async () => {
    mocks.findByIdForWorkspace.mockResolvedValue(
      baseSession({ actorUserId: null, actorTokenId: "token-a" }),
    )

    await expect(
      connectSessionService.requireByIdForWorkspaceAndActor({
        id: "session-1",
        workspaceId: "ws-1",
        actorTokenId: "token-b",
      }),
    ).rejects.toMatchObject({ code: "notFound" })
  })

  it("attaches the server-owned provider reference and encrypted auth", async () => {
    const encryptedAuth = { v: 1, iv: "a", text: "b", tag: "c" } as never

    const session = await connectSessionService.attachProviderRuntime({
      id: "session-1",
      workspaceId: "ws-1",
      providerReference: "account-1",
      encryptedAuth,
    })

    expect(session.providerReference).toBe("account-1")
    expect(mocks.updateWhereStatusIn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-1",
        workspaceId: "ws-1",
        statuses: ["pending"],
        values: expect.objectContaining({
          encryptedAuth,
          providerReference: "account-1",
          step: "prepare_qr",
        }),
      }),
    )
  })

  it("updates a QR state only while the session remains active", async () => {
    const nextAction = {
      type: "display_qr",
      state: "ready",
      qrImage: "c3ludGhldGlj",
      retryable: true,
    } as const

    await connectSessionService.updateQrState({
      id: "session-1",
      workspaceId: "ws-1",
      nextAction,
      step: "scan_qr",
      providerCursor: "42",
      providerFenceToken: "3",
      expectedProviderCursor: null,
      expectedProviderFenceToken: null,
    })

    expect(mocks.updateWhereStatusIn).toHaveBeenCalledWith(
      expect.objectContaining({
        requireUnexpired: true,
        values: {
          nextAction,
          step: "scan_qr",
          providerCursor: "42",
          providerFenceToken: "3",
        },
      }),
    )
  })

  it("initializes the QR event baseline once before provider commands can emit events", async () => {
    await connectSessionService.initializeQrEventBaseline({
      id: "session-1",
      workspaceId: "ws-1",
      providerCursor: "42",
    })

    expect(mocks.updateWhereStatusIn).toHaveBeenCalledWith({
      id: "session-1",
      workspaceId: "ws-1",
      statuses: ["pending", "authorized", "awaiting_selection"],
      requireUnexpired: true,
      expectedProviderCursor: null,
      expectedProviderFenceToken: null,
      values: { providerCursor: "42" },
    })
  })

  it("completes a provisioned session exactly once", async () => {
    const session = await connectSessionService.completeProvisioned({
      id: "session-1",
      workspaceId: "ws-1",
      connectionId: "connection-1",
    })

    expect(session.status).toBe("completed")
    expect(mocks.completeProvisioned).toHaveBeenCalledWith({
      id: "session-1",
      workspaceId: "ws-1",
      connectionId: "connection-1",
    })
  })
})

describe("connectSessionService.create", () => {
  it("throws connectSessionLimitReached at the per-workspace pending cap", async () => {
    mocks.countActiveByWorkspaceId.mockResolvedValue(20)
    await expect(
      connectSessionService.create({
        workspaceId: "ws-1",
        provider: "messenger",
        purpose: "connect",
        actorUserId: "user-1",
      }),
    ).rejects.toMatchObject({ code: "connectSessionLimitReached" })
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it("rejects an external return URL before creating a session", async () => {
    await expect(
      connectSessionService.create({
        workspaceId: "ws-1",
        provider: "messenger",
        purpose: "connect",
        actorUserId: "user-1",
        returnUrl: "https://attacker.example",
      }),
    ).rejects.toMatchObject({ code: "validation" })
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it("rejects a bare relative return URL before creating a session", async () => {
    await expect(
      connectSessionService.create({
        workspaceId: "ws-1",
        provider: "messenger",
        purpose: "connect",
        actorUserId: "user-1",
        returnUrl: "connection/complete",
      }),
    ).rejects.toMatchObject({ code: "validation" })
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it.each([
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
  ])("rejects a control-character return URL before URL normalization", async (returnUrl) => {
    await expect(
      connectSessionService.create({
        workspaceId: "ws-1",
        provider: "messenger",
        purpose: "connect",
        actorUserId: "user-1",
        returnUrl,
      }),
    ).rejects.toMatchObject({ code: "validation" })
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it.each([
    "/..//evil.example",
    "/.//evil.example",
    "/%2e%2e//evil.example",
    "/a\\b",
    "/x\u0000y",
  ])("rejects %j, including inputs that normalize to a protocol-relative URL", async (returnUrl) => {
    await expect(
      connectSessionService.create({
        workspaceId: "ws-1",
        provider: "messenger",
        purpose: "connect",
        actorUserId: "user-1",
        returnUrl,
      }),
    ).rejects.toMatchObject({ code: "validation" })
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it.each([
    ["/space/1/settings?a=1&b=2#frag", "/space/1/settings?a=1&b=2#frag"],
    ["/a/../b", "/b"],
    ["/", "/"],
  ])("accepts and normalizes the legitimate path %s", async (input, expected) => {
    mocks.insert.mockImplementation(
      async (values: Record<string, unknown>) => ({
        ...baseSession(),
        ...values,
      }),
    )
    const { session } = await connectSessionService.create({
      workspaceId: "ws-1",
      provider: "messenger",
      purpose: "connect",
      actorUserId: "user-1",
      returnUrl: input,
    })
    expect(session.returnUrl).toBe(expected)
  })

  it("persists originHost", async () => {
    mocks.insert.mockImplementation(
      async (values: Record<string, unknown>) => ({
        ...baseSession(),
        ...values,
      }),
    )
    await connectSessionService.create({
      workspaceId: "ws-1",
      provider: "messenger",
      purpose: "connect",
      actorUserId: "user-1",
      originHost: "tenant.example.org",
    })
    expect(mocks.insert.mock.calls[0]?.[0]).toMatchObject({
      originHost: "tenant.example.org",
    })
  })

  it("mints a nonce whose hash resolves back to the inserted session via findByNonce", async () => {
    mocks.insert.mockImplementation(
      async (values: Record<string, unknown>) => ({
        ...baseSession(),
        ...values,
      }),
    )

    const { session, nonce } = await connectSessionService.create({
      workspaceId: "ws-1",
      provider: "messenger",
      purpose: "connect",
      actorUserId: "user-1",
    })

    expect(session.status).toBe("pending")
    expect(typeof nonce).toBe("string")
    expect(nonce).toHaveLength(64) // 32 bytes hex-encoded

    const insertedHash = mocks.insert.mock.calls[0][0].stateNonceHash
    mocks.findByStateNonceHash.mockImplementation(
      async (input: { stateNonceHash: string }) =>
        input.stateNonceHash === insertedHash ? session : undefined,
    )

    await expect(connectSessionService.findByNonce(nonce)).resolves.toEqual(
      session,
    )
    await expect(
      connectSessionService.findByNonce("wrong-nonce"),
    ).resolves.toBeUndefined()
  })

  it("forwards an optional tx to both the active-count check and the insert (a caller minting the session's workspace in the same breath can run both atomically)", async () => {
    mocks.insert.mockImplementation(
      async (values: Record<string, unknown>) => ({
        ...baseSession(),
        ...values,
      }),
    )
    // Test seam: a literal tag is enough to prove the same reference is
    // forwarded to both repository calls; the repository itself is mocked.
    const tx = "tx" as unknown as Parameters<
      typeof connectSessionService.create
    >[1]

    await connectSessionService.create(
      {
        workspaceId: "ws-1",
        provider: "messenger",
        purpose: "connect",
        actorUserId: "user-1",
      },
      tx,
    )

    expect(mocks.countActiveByWorkspaceId).toHaveBeenCalledWith(
      { workspaceId: "ws-1" },
      tx,
    )
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" }),
      tx,
    )
  })
})

describe("expiry rule", () => {
  it("lazily flips an active session past expiresAt to expired, guarded and clearing consumedAt/encryptedAuth", async () => {
    mocks.findByIdForWorkspace.mockResolvedValue(
      baseSession({ expiresAt: PAST, status: "pending" }),
    )

    const result = await connectSessionService.findByIdForWorkspace({
      id: "session-1",
      workspaceId: "ws-1",
    })

    expect(result?.status).toBe("expired")
    expect(mocks.updateWhereStatusIn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-1",
        statuses: expect.arrayContaining([
          "pending",
          "authorized",
          "awaiting_selection",
        ]),
        values: expect.objectContaining({
          status: "expired",
          consumedAt: expect.any(Date),
          encryptedAuth: null,
          nextAction: null,
        }),
      }),
    )
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it("reports managed Zalo QR as expired without erasing its retryable cleanup capability", async () => {
    const encryptedAuth = { v: 1, text: "encrypted" }
    mocks.updateWhereStatusIn.mockResolvedValue(
      baseSession({
        expiresAt: PAST,
        provider: "zalo_personal",
        providerReference: "account-1",
        encryptedAuth,
        nextAction: null,
        step: "cleanup_pending",
      }),
    )
    mocks.findByIdForWorkspace.mockResolvedValue(
      baseSession({
        expiresAt: PAST,
        provider: "zalo_personal",
        providerReference: "account-1",
        encryptedAuth,
        nextAction: {
          type: "display_qr",
          state: "ready",
          qrImage: "sensitive-image",
          retryable: true,
        },
      }),
    )

    const result = await connectSessionService.findByIdForWorkspace({
      id: "session-1",
      workspaceId: "ws-1",
    })

    expect(result).toMatchObject({
      status: "expired",
      encryptedAuth,
      nextAction: null,
    })
    expect(mocks.updateWhereStatusIn).toHaveBeenCalledWith({
      id: "session-1",
      workspaceId: "ws-1",
      statuses: ["pending", "authorized", "awaiting_selection"],
      expectedStep: undefined,
      values: { nextAction: null, step: "cleanup_pending" },
    })
  })

  it.each([
    "cleanup_failed:provider_error",
    "cleanup_cancelled",
  ])("preserves the claimed %s outcome while lazily redacting expired QR data", async (step) => {
    const encryptedAuth = { v: 1, text: "encrypted" }
    mocks.findByIdForWorkspace.mockResolvedValue(
      baseSession({
        expiresAt: PAST,
        provider: "zalo_personal",
        providerReference: "account-1",
        encryptedAuth,
        nextAction: null,
        step,
      }),
    )

    await connectSessionService.findByIdForWorkspace({
      id: "session-1",
      workspaceId: "ws-1",
    })

    expect(mocks.updateWhereStatusIn).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedStep: step,
        values: { nextAction: null, step },
      }),
    )
  })

  it("does not flip a session a concurrent completion already made terminal (regression: lazy expiry must not overwrite a concurrent completion)", async () => {
    mocks.findByIdForWorkspace.mockResolvedValue(
      baseSession({ expiresAt: PAST, status: "pending" }),
    )
    mocks.updateWhereStatusIn.mockResolvedValue(undefined)
    mocks.findById.mockResolvedValue(baseSession({ status: "completed" }))

    const result = await connectSessionService.findByIdForWorkspace({
      id: "session-1",
      workspaceId: "ws-1",
    })

    expect(result?.status).toBe("completed")
  })

  it("does not touch a terminal-status session past expiresAt", async () => {
    mocks.findByIdForWorkspace.mockResolvedValue(
      baseSession({ expiresAt: PAST, status: "completed" }),
    )

    const result = await connectSessionService.findByIdForWorkspace({
      id: "session-1",
      workspaceId: "ws-1",
    })

    expect(result?.status).toBe("completed")
    expect(mocks.updateWhereStatusIn).not.toHaveBeenCalled()
  })

  it("returns an unexpired session unchanged", async () => {
    mocks.findByIdForWorkspace.mockResolvedValue(baseSession())

    const result = await connectSessionService.findByIdForWorkspace({
      id: "session-1",
      workspaceId: "ws-1",
    })

    expect(result?.status).toBe("pending")
    expect(mocks.updateWhereStatusIn).not.toHaveBeenCalled()
  })
})

describe("connectSessionService.attachAuthorization", () => {
  it("throws connectSessionExpired when the session is not active", async () => {
    mocks.updateWhereStatusIn.mockResolvedValueOnce(undefined)
    mocks.findById.mockResolvedValue(baseSession({ status: "completed" }))

    await expect(
      connectSessionService.attachAuthorization({
        id: "session-1",
        workspaceId: "ws-1",
        encryptedAuth: { iv: "x", ciphertext: "y", keyId: "k" } as never,
        targets: [],
      }),
    ).rejects.toMatchObject({ code: "connectSessionExpired" })
  })

  it("moves an active session to awaiting_selection with the given targets", async () => {
    const targets = [{ id: "page-1", name: "Page One", selectable: true }]
    await connectSessionService.attachAuthorization({
      id: "session-1",
      workspaceId: "ws-1",
      encryptedAuth: { iv: "x", ciphertext: "y", keyId: "k" } as never,
      targets,
    })

    expect(mocks.updateWhereStatusIn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-1",
        statuses: expect.arrayContaining([
          "pending",
          "authorized",
          "awaiting_selection",
        ]),
        values: expect.objectContaining({
          status: "awaiting_selection",
          step: "select",
          targets,
        }),
      }),
    )
  })

  describe("connectSessionService.storeAuthorization", () => {
    it("stores auth and extends the candidate-listing retry deadline", async () => {
      await connectSessionService.storeAuthorization({
        id: "session-1",
        workspaceId: "ws-1",
        encryptedAuth: { iv: "x", ciphertext: "y", keyId: "k" } as never,
      })

      expect(mocks.updateWhereStatusIn).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "session-1",
          workspaceId: "ws-1",
          statuses: ["authorized"],
          requireUnexpired: true,
          values: expect.objectContaining({
            encryptedAuth: { iv: "x", ciphertext: "y", keyId: "k" },
            expiresAt: expect.any(Date),
          }),
        }),
      )
    })
  })

  it("does not use an unscoped lookup for a missing session", async () => {
    mocks.updateWhereStatusIn.mockResolvedValue(undefined)

    await expect(
      connectSessionService.attachAuthorization({
        id: "missing",
        workspaceId: "ws-1",
        encryptedAuth: { iv: "x", ciphertext: "y", keyId: "k" } as never,
        targets: [],
      }),
    ).rejects.toMatchObject({ code: "connectSessionExpired" })
    expect(mocks.findById).not.toHaveBeenCalled()
  })
})

describe("connectSessionService.claimAuthorization", () => {
  it("claims an OAuth callback with a pending-only compare-and-set", async () => {
    await expect(
      connectSessionService.claimAuthorization({
        id: "session-1",
        workspaceId: "ws-1",
      }),
    ).resolves.toMatchObject({ status: "authorized" })

    expect(mocks.updateWhereStatusIn).toHaveBeenCalledWith({
      id: "session-1",
      workspaceId: "ws-1",
      statuses: ["pending"],
      requireUnexpired: true,
      values: { status: "authorized" },
    })
  })
})

describe("connectSessionService.claimTarget", () => {
  it("scopes atomic claims to the session workspace", async () => {
    mocks.claimTarget.mockResolvedValue(true)
    await expect(
      connectSessionService.claimTarget({
        id: "session-1",
        workspaceId: "ws-1",
        targetId: "page-1",
        ownerToken: "owner-token",
      }),
    ).resolves.toBe(true)
    expect(mocks.claimTarget).toHaveBeenCalledWith({
      id: "session-1",
      targetId: "page-1",
      workspaceId: "ws-1",
      ownerToken: "owner-token",
      leaseExpiresAt: expect.any(Date),
    })
  })

  it("returns false when the target was already claimed (race lost)", async () => {
    mocks.claimTarget.mockResolvedValue(false)
    await expect(
      connectSessionService.claimTarget({
        id: "session-1",
        workspaceId: "ws-1",
        targetId: "page-1",
        ownerToken: "owner-token",
      }),
    ).resolves.toBe(false)
  })
})

describe("connectSessionService.recordResults", () => {
  it("scopes atomic result merges to the session workspace", async () => {
    mocks.appendResults.mockResolvedValue(
      baseSession({ status: "awaiting_selection" }),
    )
    const result = await connectSessionService.recordResults({
      id: "session-1",
      workspaceId: "ws-1",
      results: [{ targetId: "a", status: "connected", connectionId: "c1" }],
      resultConnectionIds: ["c1"],
    })
    expect(mocks.appendResults).toHaveBeenCalledWith({
      id: "session-1",
      workspaceId: "ws-1",
      results: [{ targetId: "a", status: "connected", connectionId: "c1" }],
      resultConnectionIds: ["c1"],
    })
    expect(result.status).toBe("awaiting_selection")
  })

  it("returns the session's current terminal row instead of throwing when the atomic update's status guard no-ops (regression: a concurrent/replayed batch on an already-terminal session)", async () => {
    mocks.appendResults.mockResolvedValue(undefined)
    mocks.findByIdForWorkspace.mockResolvedValue(
      baseSession({ status: "completed" }),
    )

    const result = await connectSessionService.recordResults({
      id: "session-1",
      workspaceId: "ws-1",
      results: [{ targetId: "a", status: "connected", connectionId: "c1" }],
      resultConnectionIds: ["c1"],
    })

    expect(result.status).toBe("completed")
  })

  it("throws when the session truly does not exist", async () => {
    mocks.appendResults.mockResolvedValue(undefined)
    mocks.findByIdForWorkspace.mockResolvedValue(undefined)

    await expect(
      connectSessionService.recordResults({
        id: "session-missing",
        workspaceId: "ws-1",
        results: [],
        resultConnectionIds: [],
      }),
    ).rejects.toMatchObject({ code: "notFound" })
  })
})

describe("connectSessionService.completeSelection", () => {
  it("completes an awaiting_selection session and clears the remaining candidates' encrypted auth", async () => {
    const result = await connectSessionService.completeSelection({
      id: "session-1",
      workspaceId: "ws-1",
    })

    expect(mocks.updateWhereStatusIn).toHaveBeenCalledWith({
      id: "session-1",
      workspaceId: "ws-1",
      statuses: ["awaiting_selection"],
      values: {
        status: "completed",
        step: "done",
        consumedAt: expect.any(Date),
        encryptedAuth: null,
        nextAction: null,
      },
    })
    expect(result.status).toBe("completed")
  })

  it("returns the current row when the session is no longer awaiting selection", async () => {
    mocks.updateWhereStatusIn.mockResolvedValue(undefined)
    mocks.findByIdForWorkspace.mockResolvedValue(
      baseSession({ status: "cancelled" }),
    )

    const result = await connectSessionService.completeSelection({
      id: "session-1",
      workspaceId: "ws-1",
    })

    expect(result.status).toBe("cancelled")
  })
})

describe("connectSessionService.completeReconnect", () => {
  it("completes a pending reconnect session with its connected result", async () => {
    const result = await connectSessionService.completeReconnect({
      id: "session-1",
      workspaceId: "ws-1",
      tx: "tx" as never,
      result: {
        targetId: "page-1",
        status: "connected",
        connectionId: "conn-1",
      },
    })

    expect(mocks.completeReconnect).toHaveBeenCalledWith(
      {
        id: "session-1",
        workspaceId: "ws-1",
        result: {
          targetId: "page-1",
          status: "connected",
          connectionId: "conn-1",
        },
      },
      "tx",
    )
    expect(result.status).toBe("completed")
  })

  it("throws when the atomic reconnect completion no-ops", async () => {
    mocks.completeReconnect.mockResolvedValueOnce(undefined)

    await expect(
      connectSessionService.completeReconnect({
        id: "session-1",
        workspaceId: "ws-1",
        tx: "tx" as never,
        result: {
          targetId: "page-1",
          status: "connected",
          connectionId: "conn-1",
        },
      }),
    ).rejects.toMatchObject({ code: "connectSessionExpired" })
  })
})

describe("connectSessionService.releaseTarget", () => {
  it("scopes claim releases to the session workspace", async () => {
    await connectSessionService.releaseTarget({
      id: "session-1",
      workspaceId: "ws-1",
      targetId: "page-1",
      ownerToken: "owner-token",
    })
    expect(mocks.releaseTarget).toHaveBeenCalledWith({
      id: "session-1",
      targetId: "page-1",
      workspaceId: "ws-1",
      ownerToken: "owner-token",
    })
  })
})

describe("connectSessionService.fail / cancel", () => {
  it("fail sets status failed with the given errorCode, guarded to active sessions only", async () => {
    const result = await connectSessionService.fail({
      id: "session-1",
      workspaceId: "ws-1",
      errorCode: "provider_denied",
    })
    expect(result.status).toBe("failed")
    expect(result.errorCode).toBe("provider_denied")
    expect(mocks.updateWhereStatusIn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-1",
        statuses: expect.arrayContaining([
          "pending",
          "authorized",
          "awaiting_selection",
        ]),
      }),
    )
  })

  it("does not flip an already-terminal session (regression: a replayed OAuth callback `?error=` must not override a completed session)", async () => {
    mocks.updateWhereStatusIn.mockResolvedValue(undefined)
    mocks.findByIdForWorkspace.mockResolvedValue(
      baseSession({ status: "completed" }),
    )
    const result = await connectSessionService.fail({
      id: "session-1",
      workspaceId: "ws-1",
      errorCode: "provider_denied",
    })

    expect(result.status).toBe("completed")
  })

  it("cancel requires the session to belong to the workspace", async () => {
    mocks.findByIdForWorkspace.mockResolvedValue(undefined)
    await expect(
      connectSessionService.cancel({ id: "session-1", workspaceId: "ws-1" }),
    ).rejects.toMatchObject({ code: "notFound" })
  })

  it("cancel sets status cancelled for an owned session", async () => {
    mocks.findByIdForWorkspace.mockResolvedValue(baseSession())
    const result = await connectSessionService.cancel({
      id: "session-1",
      workspaceId: "ws-1",
    })
    expect(result.status).toBe("cancelled")
  })

  it("cancel does not flip an already-terminal session", async () => {
    mocks.findByIdForWorkspace.mockResolvedValue(
      baseSession({ status: "failed", errorCode: "provider_denied" }),
    )
    mocks.updateWhereStatusIn.mockResolvedValue(undefined)

    const result = await connectSessionService.cancel({
      id: "session-1",
      workspaceId: "ws-1",
    })

    expect(result.status).toBe("failed")
  })
})

describe("connectSessionService.purgeExpired", () => {
  it("delegates the bulk expire to connectSessionRepository.expireDue and reports its count", async () => {
    mocks.expireDue.mockResolvedValue(2)

    const result = await connectSessionService.purgeExpired({
      retentionDays: 7,
      chunkSize: 500,
      interChunkDelayMs: 100,
      maxChunks: 1000,
    })

    expect(mocks.expireDue).toHaveBeenCalledWith(
      expect.objectContaining({
        preserveRuntimeForProvider: "zalo_personal",
        statuses: expect.arrayContaining([
          "pending",
          "authorized",
          "awaiting_selection",
        ]),
      }),
    )
    expect(result.expired).toBe(2)
  })

  it("delegates the terminal-row retention delete to connectSessionRepository.purgeOldTerminal and reports its count/stopReason", async () => {
    mocks.purgeOldTerminal.mockResolvedValue({
      deleted: 5,
      stopReason: "chunkCap",
    })

    const result = await connectSessionService.purgeExpired({
      retentionDays: 7,
      chunkSize: 500,
      interChunkDelayMs: 100,
      maxChunks: 1000,
    })

    expect(mocks.purgeOldTerminal).toHaveBeenCalledWith({
      retentionDays: 7,
      chunkSize: 500,
      interChunkDelayMs: 100,
      maxChunks: 1000,
    })
    expect(result.deletedTerminal).toBe(5)
    expect(result.terminalPurgeStopReason).toBe("chunkCap")
  })
})

describe("connectSessionService.updateReturnUrl", () => {
  it("sets returnUrl on the given session", async () => {
    const result = await connectSessionService.updateReturnUrl({
      id: "session-1",
      returnUrl: "/channels/messenger/select?session=session-1",
    })
    expect(result.returnUrl).toBe(
      "/channels/messenger/select?session=session-1",
    )
    expect(mocks.updateWhereStatusIn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-1",
        values: { returnUrl: "/channels/messenger/select?session=session-1" },
      }),
    )
  })

  it("throws notFound when the session does not exist or is no longer active", async () => {
    mocks.updateWhereStatusIn.mockResolvedValue(undefined)
    await expect(
      connectSessionService.updateReturnUrl({
        id: "missing",
        returnUrl: "/channels/messenger/select?session=missing",
      }),
    ).rejects.toMatchObject({ code: "notFound" })
  })
})

describe("connectSessionService.submitInput", () => {
  it("records nextAction on an active session", async () => {
    const nextAction = { type: "wait" } as never
    const result = await connectSessionService.submitInput({
      id: "session-1",
      workspaceId: "ws-1",
      nextAction,
    })

    expect(result.nextAction).toEqual(nextAction)
    expect(mocks.updateWhereStatusIn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-1",
        statuses: expect.arrayContaining([
          "pending",
          "authorized",
          "awaiting_selection",
        ]),
        values: { nextAction },
      }),
    )
  })

  it("throws connectSessionExpired instead of reviving an already-terminal session", async () => {
    mocks.updateWhereStatusIn.mockResolvedValueOnce(undefined)
    mocks.findById.mockResolvedValue(baseSession({ status: "cancelled" }))

    await expect(
      connectSessionService.submitInput({
        id: "session-1",
        workspaceId: "ws-1",
        nextAction: { type: "wait" } as never,
      }),
    ).rejects.toMatchObject({ code: "connectSessionExpired" })
  })
})

describe("connectSessionService.cancelPendingByProvider", () => {
  beforeEach(() => {
    mocks.cancelPendingByProvider.mockReset()
  })

  it("delegates with the workspace and provider scope and returns the count", async () => {
    mocks.cancelPendingByProvider.mockResolvedValueOnce(3)

    const count = await connectSessionService.cancelPendingByProvider({
      workspaceId: "ws-1",
      provider: "googleAds",
    })

    expect(count).toBe(3)
    expect(mocks.cancelPendingByProvider).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      provider: "googleAds",
    })
  })
})
