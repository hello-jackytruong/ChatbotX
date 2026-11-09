import {
  type ConnectSessionActor,
  connectSessionService,
} from "@chatbotx.io/business/connect-session"
import {
  isActiveConnectionStatus,
  resolveOwnerId,
} from "@chatbotx.io/business/connection"
import {
  type ZaloPersonalRuntimeAuth,
  zaloPersonalRuntimeAuthSchema,
} from "@chatbotx.io/business/integration-zalo-personal"
import {
  ZaloPersonalBridgeClient,
  ZaloPersonalBridgeHttpError,
} from "@chatbotx.io/business/zalo-personal-bridge"
import { connectionRepository } from "@chatbotx.io/database/repositories"
import type { ConnectSessionModel } from "@chatbotx.io/database/types"
import { encryptUtils } from "@chatbotx.io/encryption"
import { bridgeEventPageSchema } from "@chatbotx.io/integration-zalo-personal/schema"
import { z } from "zod"
import { connectAndPersist, resolveAdapter } from "./internal"
import { logger } from "./logger"

const provisionedAccountSchema = z
  .object({
    version: z.literal(1),
    accountId: z.string().min(1),
    keyId: z.string().min(1),
    secret: z.string().min(1),
  })
  .strict()

const accountEventEnvelopeSchema = z
  .object({
    room: z.string().nullable(),
    event: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()

type QrEventTransition =
  | {
      kind: "state"
      step: string
      nextAction: {
        type: "display_qr"
        state:
          | "preparing"
          | "ready"
          | "scanned"
          | "connecting"
          | "expired"
          | "session_dead"
        qrImage?: string
        retryable: boolean
      }
    }
  | { kind: "connected" }
  | {
      kind: "failed"
      errorCode: "already_connected" | "provider_error"
    }

export function mapZaloPersonalQrEvent(input: {
  expectedAccountId: string
  envelope: unknown
}): QrEventTransition {
  const envelope = accountEventEnvelopeSchema.parse(input.envelope)
  const accountId = z.string().min(1).parse(envelope.payload.accountId)
  if (accountId !== input.expectedAccountId) {
    throw new Error("ZALO_PERSONAL_QR_ACCOUNT_MISMATCH")
  }
  switch (envelope.event) {
    case "zalo:qr":
      if (envelope.payload.redacted === true && !envelope.payload.qrImage) {
        return {
          kind: "state",
          step: "refresh_qr",
          nextAction: {
            type: "display_qr",
            state: "expired",
            retryable: true,
          },
        }
      }
      return {
        kind: "state",
        step: "scan_qr",
        nextAction: {
          type: "display_qr",
          state: "ready",
          qrImage: z.string().min(1).parse(envelope.payload.qrImage),
          retryable: true,
        },
      }
    case "zalo:scanned":
      return {
        kind: "state",
        step: "confirming",
        nextAction: {
          type: "display_qr",
          state: "scanned",
          retryable: true,
        },
      }
    case "zalo:qr-expired":
      return {
        kind: "state",
        step: "refresh_qr",
        nextAction: {
          type: "display_qr",
          state: "expired",
          retryable: true,
        },
      }
    case "zalo:connecting":
      return {
        kind: "state",
        step: "connecting",
        nextAction: {
          type: "display_qr",
          state: "connecting",
          retryable: true,
        },
      }
    case "zalo:connected":
      return { kind: "connected" }
    case "zalo:qr-session-dead":
    case "zalo:error":
    case "zalo:reconnect-failed":
      return { kind: "failed", errorCode: "provider_error" }
    case "zalo:duplicate":
      return { kind: "failed", errorCode: "already_connected" }
    default:
      throw new Error("ZALO_PERSONAL_QR_EVENT_UNSUPPORTED")
  }
}

export type ZaloPersonalProvisioningCredential = {
  bridgeUrl: string
  kid: string
  secret: string
}

const sessionAuthAad = (sessionId: string): string =>
  `connect-session:${sessionId}:authorization`

const loginCommandId = (sessionId: string): string =>
  `zalo-qr-login-${sessionId}`

async function decryptSessionAuth(session: ConnectSessionModel) {
  if (!(session.providerReference && session.encryptedAuth)) {
    throw new Error("ZALO_PERSONAL_QR_RUNTIME_MISSING")
  }
  const auth = zaloPersonalRuntimeAuthSchema.parse(
    await encryptUtils.decryptObject(
      session.encryptedAuth,
      zaloPersonalRuntimeAuthSchema,
      sessionAuthAad(session.id),
    ),
  )
  if (auth.accountId !== session.providerReference) {
    throw new Error("ZALO_PERSONAL_QR_ACCOUNT_MISMATCH")
  }
  return auth
}

async function loadOrProvisionRuntime(input: {
  session: ConnectSessionModel
  provisioning: ZaloPersonalProvisioningCredential
}): Promise<{
  auth: z.infer<typeof zaloPersonalRuntimeAuthSchema>
  session: ConnectSessionModel
}> {
  if (input.session.providerReference && input.session.encryptedAuth) {
    return {
      auth: zaloPersonalRuntimeAuthSchema.parse(
        await encryptUtils.decryptObject(
          input.session.encryptedAuth,
          zaloPersonalRuntimeAuthSchema,
          sessionAuthAad(input.session.id),
        ),
      ),
      session: input.session,
    }
  }

  const provisioningClient = new ZaloPersonalBridgeClient({
    baseUrl: input.provisioning.bridgeUrl,
    kid: input.provisioning.kid,
    secret: input.provisioning.secret,
  })
  const provisioned = provisionedAccountSchema.parse(
    await provisioningClient.provisionAccount({
      connectSessionId: input.session.id,
      workspaceId: input.session.workspaceId,
    }),
  )
  const auth = zaloPersonalRuntimeAuthSchema.parse({
    authType: "custom",
    accountId: provisioned.accountId,
    bridgeUrl: input.provisioning.bridgeUrl,
    keyId: provisioned.keyId,
    secret: provisioned.secret,
    managedBy: "chatbotx_qr",
    connectSessionId: input.session.id,
  })
  const encryptedAuth = await encryptUtils.encryptObject(
    auth,
    sessionAuthAad(input.session.id),
  )
  const session = await connectSessionService.attachProviderRuntime({
    id: input.session.id,
    workspaceId: input.session.workspaceId,
    providerReference: provisioned.accountId,
    encryptedAuth,
  })
  return { auth, session }
}

async function initializeQrEventBaseline(input: {
  session: ConnectSessionModel
  auth: z.infer<typeof zaloPersonalRuntimeAuthSchema>
  client: ZaloPersonalBridgeClient
}): Promise<ConnectSessionModel> {
  if (input.session.providerCursor !== null) {
    return input.session
  }
  const page = bridgeEventPageSchema.parse(
    await input.client.listEvents({
      accountId: input.auth.accountId,
      after: "0",
      limit: 1,
    }),
  )
  if (page.accountId !== input.auth.accountId) {
    throw new Error("ZALO_PERSONAL_QR_ACCOUNT_MISMATCH")
  }
  return await connectSessionService.initializeQrEventBaseline({
    id: input.session.id,
    workspaceId: input.session.workspaceId,
    providerCursor: page.highWaterMark,
  })
}

export async function startZaloPersonalQrSession(
  input: {
    workspaceId: string
    platformOwnerId: string
    provisioning: ZaloPersonalProvisioningCredential
  } & ConnectSessionActor,
): Promise<ConnectSessionModel> {
  const session = await connectSessionService.createOrResumeQrSession({
    workspaceId: input.workspaceId,
    provider: "zalo_personal",
    purpose: "connect",
    platformOwnerId: input.platformOwnerId,
    ...(input.actorUserId === undefined
      ? { actorTokenId: input.actorTokenId }
      : { actorUserId: input.actorUserId }),
  })

  const runtime = await loadOrProvisionRuntime({
    session,
    provisioning: input.provisioning,
  })
  const commandId = loginCommandId(session.id)
  const client = new ZaloPersonalBridgeClient({
    baseUrl: runtime.auth.bridgeUrl,
    kid: runtime.auth.keyId,
    secret: runtime.auth.secret,
  })
  const initializedSession = await initializeQrEventBaseline({
    session: runtime.session,
    auth: runtime.auth,
    client,
  })
  await client.acceptCommand({
    version: 1,
    commandId,
    idempotencyKey: commandId,
    accountId: runtime.auth.accountId,
    kind: "loginWithQr",
    payload: { args: [] },
    requestedAt: session.createdAt.toISOString(),
    deadlineAt: session.expiresAt.toISOString(),
    traceId: commandId,
  })

  return initializedSession
}

export async function startZaloPersonalQrReconnect(
  input: {
    connectionId: string
    workspaceId: string
    platformOwnerId: string
    auth: ZaloPersonalRuntimeAuth
  } & ConnectSessionActor,
): Promise<ConnectSessionModel> {
  const auth = zaloPersonalRuntimeAuthSchema.parse(input.auth)
  const session = await connectSessionService.createOrResumeQrSession({
    workspaceId: input.workspaceId,
    provider: "zalo_personal",
    purpose: "reconnect",
    targetConnectionId: input.connectionId,
    platformOwnerId: input.platformOwnerId,
    ...(input.actorUserId === undefined
      ? { actorTokenId: input.actorTokenId }
      : { actorUserId: input.actorUserId }),
  })
  let runtimeSession = session
  if (!(session.providerReference && session.encryptedAuth)) {
    runtimeSession = await connectSessionService.attachProviderRuntime({
      id: session.id,
      workspaceId: session.workspaceId,
      providerReference: auth.accountId,
      encryptedAuth: await encryptUtils.encryptObject(
        auth,
        sessionAuthAad(session.id),
      ),
    })
  }
  const commandId = loginCommandId(session.id)
  const client = new ZaloPersonalBridgeClient({
    baseUrl: auth.bridgeUrl,
    kid: auth.keyId,
    secret: auth.secret,
  })
  runtimeSession = await initializeQrEventBaseline({
    session: runtimeSession,
    auth,
    client,
  })
  await client.acceptCommand({
    version: 1,
    commandId,
    idempotencyKey: commandId,
    accountId: auth.accountId,
    kind: "loginWithQr",
    payload: { args: [] },
    requestedAt: session.createdAt.toISOString(),
    deadlineAt: session.expiresAt.toISOString(),
    traceId: commandId,
  })
  return runtimeSession
}

async function finalizeZaloPersonalQrSession(input: {
  session: ConnectSessionModel
  auth: z.infer<typeof zaloPersonalRuntimeAuthSchema>
}): Promise<ConnectSessionModel> {
  const adapter = resolveAdapter("zalo_personal")
  const descriptor = adapter.provider.describe(input.auth)
  const target = input.session.targetConnectionId
    ? await connectionRepository.findByIdForWorkspace({
        id: input.session.targetConnectionId,
        workspaceId: input.session.workspaceId,
      })
    : undefined
  if (target && target.sourceId !== descriptor.sourceId) {
    throw new Error("ZALO_PERSONAL_RECONNECT_IDENTITY_MISMATCH")
  }
  const matching = await connectionRepository.findByProviderSourceId({
    workspaceId: input.session.workspaceId,
    provider: "zalo_personal",
    sourceId: descriptor.sourceId,
  })
  if (target && matching && matching.id !== target.id) {
    throw new Error("ZALO_PERSONAL_RECONNECT_CONNECTION_MISMATCH")
  }
  const existing = target ?? matching
  const ownerId = await resolveOwnerId({
    kind: "channel",
    workspaceId: input.session.workspaceId,
  })
  let connection =
    existing && isActiveConnectionStatus(existing.status) ? existing : null
  if (!connection) {
    try {
      connection = await connectAndPersist({
        adapter,
        provider: "zalo_personal",
        workspaceId: input.session.workspaceId,
        auth: input.auth,
        descriptor,
        extraConfig: { name: descriptor.displayName },
        existing,
        ownerId,
        actorUserId: input.session.actorUserId,
        reuseExistingInboxId: true,
        missingOwnerError: new Error(
          "Zalo Personal connection requires a workspace owner",
        ),
      })
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "connectionAlreadyConnected"
        )
      ) {
        throw error
      }
      const winner = await connectionRepository.findByProviderSourceId({
        workspaceId: input.session.workspaceId,
        provider: "zalo_personal",
        sourceId: descriptor.sourceId,
      })
      if (!(winner && isActiveConnectionStatus(winner.status))) {
        throw error
      }
      connection = winner
    }
  }
  if (!connection.inboxId) {
    throw new Error("ZALO_PERSONAL_CONNECTION_INBOX_MISSING")
  }
  await new ZaloPersonalBridgeClient({
    baseUrl: input.auth.bridgeUrl,
    kid: input.auth.keyId,
    secret: input.auth.secret,
  }).bindAccount({
    accountId: input.auth.accountId,
    workspaceId: input.session.workspaceId,
    inboxId: connection.inboxId,
  })
  return await connectSessionService.completeProvisioned({
    id: input.session.id,
    workspaceId: input.session.workspaceId,
    connectionId: connection.id,
  })
}

async function cleanupFailedQrSession(input: {
  session: ConnectSessionModel
  auth: z.infer<typeof zaloPersonalRuntimeAuthSchema>
  eventId: string
  occurredAt: string
}): Promise<void> {
  const commandId = `zalo-qr-cleanup-${input.eventId}`
  const client = new ZaloPersonalBridgeClient({
    baseUrl: input.auth.bridgeUrl,
    kid: input.auth.keyId,
    secret: input.auth.secret,
  })
  try {
    await client.acceptCommand({
      version: 1,
      commandId,
      idempotencyKey: commandId,
      accountId: input.auth.accountId,
      kind: "disconnectAccount",
      payload: { args: [] },
      requestedAt: input.occurredAt,
      deadlineAt: new Date(
        Math.max(input.session.expiresAt.getTime(), Date.now() + 60_000),
      ).toISOString(),
      traceId: commandId,
    })
  } catch (err) {
    if (
      !(
        err instanceof ZaloPersonalBridgeHttpError &&
        err.code === "UNKNOWN_OR_REVOKED_KID"
      )
    ) {
      throw err
    }
  }
  if (
    input.session.purpose === "connect" &&
    input.auth.managedBy === "chatbotx_qr"
  ) {
    await client.cleanupOnboardingAccount({
      accountId: input.auth.accountId,
      connectSessionId: input.auth.connectSessionId ?? input.session.id,
    })
  }
}

const cleanupAttemptId = (session: ConnectSessionModel): string =>
  `session-${session.id}-${session.step}-${session.providerCursor ?? "none"}`

async function finishClaimedFailureCleanup(input: {
  session: ConnectSessionModel
  auth: z.infer<typeof zaloPersonalRuntimeAuthSchema>
  errorCode: "already_connected" | "provider_error"
}): Promise<ConnectSessionModel> {
  if (!(input.session.providerCursor && input.session.providerFenceToken)) {
    throw new Error("ZALO_PERSONAL_QR_CLEANUP_CURSOR_MISSING")
  }
  await cleanupFailedQrSession({
    session: input.session,
    auth: input.auth,
    eventId: cleanupAttemptId(input.session),
    occurredAt: new Date().toISOString(),
  })
  const failed = await connectSessionService.failQrSession({
    id: input.session.id,
    workspaceId: input.session.workspaceId,
    errorCode: input.errorCode,
    providerCursor: input.session.providerCursor,
    providerFenceToken: input.session.providerFenceToken,
    expectedProviderCursor: input.session.providerCursor,
    expectedProviderFenceToken: input.session.providerFenceToken,
  })
  return (
    failed ??
    (await connectSessionService.requireByIdForWorkspace({
      id: input.session.id,
      workspaceId: input.session.workspaceId,
    }))
  )
}

async function recoverExpiredConnectedSession(input: {
  session: ConnectSessionModel
  auth: z.infer<typeof zaloPersonalRuntimeAuthSchema>
}): Promise<ConnectSessionModel | null> {
  const client = new ZaloPersonalBridgeClient({
    baseUrl: input.auth.bridgeUrl,
    kid: input.auth.keyId,
    secret: input.auth.secret,
  })
  let after = input.session.providerCursor ?? "0"
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = bridgeEventPageSchema.parse(
      await client.listEvents({
        accountId: input.auth.accountId,
        after,
        limit: 100,
      }),
    )
    for (const event of page.events) {
      if (event.accountId !== input.auth.accountId) {
        throw new Error("ZALO_PERSONAL_QR_ACCOUNT_MISMATCH")
      }
      if (
        input.session.providerFenceToken &&
        BigInt(event.fenceToken) < BigInt(input.session.providerFenceToken)
      ) {
        throw new Error("ZALO_PERSONAL_QR_STALE_FENCE")
      }
      if (event.kind !== "account_status") {
        continue
      }
      const envelope = accountEventEnvelopeSchema.parse(event.payload)
      if (
        z.string().min(1).parse(envelope.payload.accountId) !==
        input.auth.accountId
      ) {
        throw new Error("ZALO_PERSONAL_QR_ACCOUNT_MISMATCH")
      }
      if (envelope.event !== "zalo:connected") {
        continue
      }
      const claimed = await connectSessionService.claimQrFinalization({
        id: input.session.id,
        workspaceId: input.session.workspaceId,
        providerCursor: event.accountSequence,
        providerFenceToken: event.fenceToken,
        expectedProviderCursor: input.session.providerCursor,
        expectedProviderFenceToken: input.session.providerFenceToken,
        expectedStep: input.session.step,
      })
      if (claimed) {
        return await finalizeZaloPersonalQrSession({
          session: claimed,
          auth: input.auth,
        })
      }
      const current = await connectSessionService.requireByIdForWorkspace({
        id: input.session.id,
        workspaceId: input.session.workspaceId,
      })
      if (current.step === "finalizing") {
        return await finalizeZaloPersonalQrSession({
          session: current,
          auth: input.auth,
        })
      }
      return current.status === "completed" ? current : null
    }
    if (page.events.length === 0 || page.nextSequence === after) {
      return null
    }
    after = page.nextSequence
    if (after === page.highWaterMark) {
      return null
    }
  }
  return null
}

export async function pollZaloPersonalQrSession(
  initialSession: ConnectSessionModel,
): Promise<ConnectSessionModel> {
  let session = initialSession
  const shouldAdvanceScannedState =
    initialSession.nextAction?.type === "display_qr" &&
    initialSession.nextAction.state === "scanned"
  const auth = await decryptSessionAuth(session)
  if (session.step === "finalizing") {
    return await finalizeZaloPersonalQrSession({ session, auth })
  }
  if (session.step.startsWith("cleanup_failed:")) {
    const errorCode = session.step.slice("cleanup_failed:".length)
    if (errorCode !== "already_connected" && errorCode !== "provider_error") {
      throw new Error("ZALO_PERSONAL_QR_CLEANUP_STATE_INVALID")
    }
    return await finishClaimedFailureCleanup({ session, auth, errorCode })
  }
  if (session.step === "cleanup_cancelled") {
    await cleanupFailedQrSession({
      session,
      auth,
      eventId: cleanupAttemptId(session),
      occurredAt: new Date().toISOString(),
    })
    return await connectSessionService.cancelQrSession({
      id: session.id,
      workspaceId: session.workspaceId,
    })
  }
  const client = new ZaloPersonalBridgeClient({
    baseUrl: auth.bridgeUrl,
    kid: auth.keyId,
    secret: auth.secret,
  })
  const page = bridgeEventPageSchema.parse(
    await client.listEvents({
      accountId: auth.accountId,
      after: session.providerCursor ?? "0",
      limit: 100,
    }),
  )
  if (page.accountId !== auth.accountId) {
    throw new Error("ZALO_PERSONAL_QR_ACCOUNT_MISMATCH")
  }

  for (const event of page.events) {
    const expectedProviderCursor = session.providerCursor
    const expectedProviderFenceToken = session.providerFenceToken
    if (event.accountId !== auth.accountId) {
      throw new Error("ZALO_PERSONAL_QR_ACCOUNT_MISMATCH")
    }
    if (
      session.providerFenceToken &&
      BigInt(event.fenceToken) < BigInt(session.providerFenceToken)
    ) {
      throw new Error("ZALO_PERSONAL_QR_STALE_FENCE")
    }
    if (event.kind !== "account_status") {
      session = await connectSessionService.advanceProviderCursor({
        id: session.id,
        workspaceId: session.workspaceId,
        providerCursor: event.accountSequence,
        providerFenceToken: event.fenceToken,
        expectedProviderCursor,
        expectedProviderFenceToken,
      })
      continue
    }
    const transition = mapZaloPersonalQrEvent({
      expectedAccountId: auth.accountId,
      envelope: event.payload,
    })
    if (transition.kind === "connected") {
      const claimed = await connectSessionService.claimQrFinalization({
        id: session.id,
        workspaceId: session.workspaceId,
        providerCursor: event.accountSequence,
        providerFenceToken: event.fenceToken,
        expectedProviderCursor,
        expectedProviderFenceToken,
        expectedStep: session.step,
      })
      if (!claimed) {
        return await connectSessionService.requireByIdForWorkspace({
          id: session.id,
          workspaceId: session.workspaceId,
        })
      }
      return await finalizeZaloPersonalQrSession({ session: claimed, auth })
    }
    if (transition.kind === "failed") {
      const claimed = await connectSessionService.claimQrFailureCleanup({
        id: session.id,
        workspaceId: session.workspaceId,
        errorCode: transition.errorCode,
        providerCursor: event.accountSequence,
        providerFenceToken: event.fenceToken,
        expectedProviderCursor,
        expectedProviderFenceToken,
        expectedStep: session.step,
      })
      if (!claimed) {
        return await connectSessionService.requireByIdForWorkspace({
          id: session.id,
          workspaceId: session.workspaceId,
        })
      }
      return await finishClaimedFailureCleanup({
        session: claimed,
        auth,
        errorCode: transition.errorCode,
      })
    }
    session = await connectSessionService.updateQrState({
      id: session.id,
      workspaceId: session.workspaceId,
      step: transition.step,
      nextAction: transition.nextAction,
      providerCursor: event.accountSequence,
      providerFenceToken: event.fenceToken,
      expectedProviderCursor,
      expectedProviderFenceToken,
    })
  }
  if (
    shouldAdvanceScannedState &&
    session.nextAction?.type === "display_qr" &&
    session.nextAction.state === "scanned" &&
    session.providerCursor &&
    session.providerFenceToken
  ) {
    session = await connectSessionService.updateQrState({
      id: session.id,
      workspaceId: session.workspaceId,
      step: "connecting",
      nextAction: {
        type: "display_qr",
        state: "connecting",
        retryable: true,
      },
      providerCursor: session.providerCursor,
      providerFenceToken: session.providerFenceToken,
      expectedProviderCursor: session.providerCursor,
      expectedProviderFenceToken: session.providerFenceToken,
    })
  }
  return session
}

export async function cancelConnectSession(
  input: {
    id: string
    workspaceId: string
  } & ConnectSessionActor,
): Promise<ConnectSessionModel> {
  const session =
    await connectSessionService.requireByIdForWorkspaceAndActor(input)
  const auth =
    session.provider === "zalo_personal" &&
    session.providerReference &&
    session.encryptedAuth
      ? await decryptSessionAuth(session)
      : null
  if (session.step === "finalizing") {
    return session
  }
  if (session.step.startsWith("cleanup_failed:") && auth) {
    const errorCode = session.step.slice("cleanup_failed:".length)
    if (errorCode === "already_connected" || errorCode === "provider_error") {
      return await finishClaimedFailureCleanup({ session, auth, errorCode })
    }
  }
  let claimed: ConnectSessionModel | undefined = session
  if (
    session.provider === "zalo_personal" &&
    session.step !== "cleanup_cancelled"
  ) {
    claimed = await connectSessionService.claimQrCancellation({
      id: session.id,
      workspaceId: session.workspaceId,
      expectedStep: session.step,
    })
  }
  if (!claimed) {
    return await connectSessionService.requireByIdForWorkspace(input)
  }
  if (claimed.provider === "zalo_personal" && auth) {
    await cleanupFailedQrSession({
      session: claimed,
      auth,
      eventId: cleanupAttemptId(claimed),
      occurredAt: new Date().toISOString(),
    })
  }
  const cancelled =
    claimed.provider === "zalo_personal"
      ? await connectSessionService.cancelQrSession(input)
      : await connectSessionService.cancel(input)
  if (cancelled.status !== "cancelled" && auth) {
    logger.warn(
      { sessionId: session.id, status: cancelled.status },
      "zalo personal QR cleanup completed after session left active state",
    )
  }
  return cancelled
}

/**
 * Expired managed QR sessions retain only their encrypted account-scoped
 * cleanup capability until this succeeds. The generic retention sweep skips
 * those rows, so a bridge outage cannot turn cleanup into a one-shot action.
 */
export async function expireZaloPersonalQrSession(
  session: ConnectSessionModel,
): Promise<ConnectSessionModel> {
  if (session.provider !== "zalo_personal") {
    throw new Error("ZALO_PERSONAL_QR_SESSION_REQUIRED")
  }
  if (session.step === "finalizing") {
    return session
  }
  const auth = await decryptSessionAuth(session)
  if (session.step.startsWith("cleanup_failed:")) {
    const errorCode = session.step.slice("cleanup_failed:".length)
    if (errorCode !== "already_connected" && errorCode !== "provider_error") {
      throw new Error("ZALO_PERSONAL_QR_CLEANUP_STATE_INVALID")
    }
    return await finishClaimedFailureCleanup({ session, auth, errorCode })
  }
  if (session.step === "cleanup_cancelled") {
    await cleanupFailedQrSession({
      session,
      auth,
      eventId: cleanupAttemptId(session),
      occurredAt: new Date().toISOString(),
    })
    return await connectSessionService.cancelQrSession({
      id: session.id,
      workspaceId: session.workspaceId,
    })
  }
  try {
    const recovered = await recoverExpiredConnectedSession({ session, auth })
    if (recovered) {
      return recovered
    }
  } catch (err) {
    if (
      !(
        session.step === "cleanup_expired" &&
        err instanceof ZaloPersonalBridgeHttpError &&
        err.code === "UNKNOWN_OR_REVOKED_KID"
      )
    ) {
      throw err
    }
  }
  const claimed =
    session.step === "cleanup_expired"
      ? session
      : await connectSessionService.claimQrExpiryCleanup({
          id: session.id,
          workspaceId: session.workspaceId,
          expectedStep: session.step,
        })
  if (!claimed) {
    return await connectSessionService.requireByIdForWorkspace({
      id: session.id,
      workspaceId: session.workspaceId,
    })
  }
  await cleanupFailedQrSession({
    session: claimed,
    auth,
    eventId: cleanupAttemptId(claimed),
    occurredAt: new Date().toISOString(),
  })
  return await connectSessionService.expireQrSession({
    id: session.id,
    workspaceId: session.workspaceId,
  })
}
