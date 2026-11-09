import { withBlockedOwnerGuard } from "@chatbotx.io/business"
import { connectSessionService } from "@chatbotx.io/business/connect-session"
import { integrationZaloPersonalService } from "@chatbotx.io/business/integration-zalo-personal"
import {
  ZaloPersonalBridgeClient,
  zaloPersonalBridgeService,
} from "@chatbotx.io/business/zalo-personal-bridge"
import { pollZaloPersonalQrSession } from "@chatbotx.io/connections/zalo-personal-qr"
import {
  type BridgeEvent,
  bridgeEventPageSchema,
} from "@chatbotx.io/integration-zalo-personal/schema"
import { getChildLogger } from "@chatbotx.io/logger"
import {
  getQueueEvents,
  IntegrationJobAction,
  integrationQueue,
  queueNames,
  waitForJobCompletionWithRetries,
} from "@chatbotx.io/worker-config"
import type { Job } from "bullmq"
import { env } from "../../env"
import {
  buildZaloPersonalInboundMappings,
  parseZaloPersonalInboundCompletion,
  type ZaloPersonalInboundCompletion,
  zaloPersonalProviderMessageId,
} from "../../lib/zalo-personal-inbound-mapping"
import { isZaloPersonalBridgeAccountEnabled } from "../../lib/zalo-personal-rollout"

const POLL_PAGE_SIZE = 100
const POLL_WAIT_MS = 30_000
const MAX_ACTIVE_ACCOUNTS_PER_RUN = 1000
const MAX_ACTIVE_QR_SESSIONS_PER_RUN = 100
const logger = getChildLogger("poll-zalo-personal-bridge")
let activeQrSessionCursor: string | undefined

const eventJobId = (eventId: string): string =>
  `zalo-personal-event-${eventId.replace(/[^a-zA-Z0-9_-]/g, "-")}`.slice(0, 120)

async function enqueueEventAndWait(
  event: BridgeEvent,
): Promise<ZaloPersonalInboundCompletion | null> {
  const messageId = zaloPersonalProviderMessageId(event)
  let payload:
    | {
        type: typeof IntegrationJobAction.incomingMessage
        data: {
          integrationType: string
          integrationIdentifier: string
          payload: unknown
        }
      }
    | {
        type: typeof IntegrationJobAction.messageStatus
        data: {
          integrationType: string
          integrationIdentifier: string
          payload: {
            messageId: string
            status: "delivered" | "read"
            timestamp: string
          }
        }
      }
    | {
        type: typeof IntegrationJobAction.deleteIncomingMessage
        data: {
          integrationType: string
          integrationIdentifier: string
          messageId: string
        }
      }
    | null = null

  if (event.kind === "message") {
    payload = {
      type: IntegrationJobAction.incomingMessage,
      data: {
        integrationType: "zalo_personal",
        integrationIdentifier: event.accountId,
        payload: event,
      },
    }
  } else if (
    (event.kind === "delivered" || event.kind === "seen") &&
    messageId
  ) {
    payload = {
      type: IntegrationJobAction.messageStatus,
      data: {
        integrationType: "zalo_personal",
        integrationIdentifier: event.accountId,
        payload: {
          messageId,
          status: event.kind === "seen" ? "read" : "delivered",
          timestamp: event.occurredAt,
        },
      },
    }
  } else if (event.kind === "undo" && messageId) {
    payload = {
      type: IntegrationJobAction.deleteIncomingMessage,
      data: {
        integrationType: "zalo_personal",
        integrationIdentifier: event.accountId,
        messageId,
      },
    }
  }

  if (!payload) {
    return null
  }
  const job = await integrationQueue.add(payload.type, payload, {
    jobId: eventJobId(event.eventId),
  })
  if (job && typeof job === "object" && "waitUntilFinished" in job) {
    const result = await waitForJobCompletionWithRetries(
      job as Job,
      integrationQueue,
      getQueueEvents(queueNames.enum.integration),
      POLL_WAIT_MS,
    )
    return parseZaloPersonalInboundCompletion(result)
  }
  return null
}

async function pollAccount(
  row: Awaited<
    ReturnType<typeof integrationZaloPersonalService.listActiveRuntimeRows>
  >[number],
): Promise<void> {
  await withBlockedOwnerGuard(row.workspaceId, async () => {
    const client = new ZaloPersonalBridgeClient({
      baseUrl: row.auth.bridgeUrl,
      kid: row.auth.keyId,
      secret: row.auth.secret,
    })
    await client.bindAccount({
      accountId: row.accountId,
      workspaceId: row.workspaceId,
      inboxId: row.inboxId,
    })
    const checkpoint = await zaloPersonalBridgeService.getCheckpoint({
      integrationId: row.id,
      accountId: row.accountId,
    })
    const page = bridgeEventPageSchema.parse(
      await client.listEvents({
        accountId: row.accountId,
        after: checkpoint?.lastSequence ?? "0",
        limit: POLL_PAGE_SIZE,
      }),
    )
    for (const event of page.events) {
      const completion = await enqueueEventAndWait(event)
      const mappings = buildZaloPersonalInboundMappings(event, completion)
      if (event.kind === "message" && !mappings) {
        throw new Error("ZALO_PERSONAL_INBOUND_MAPPING_MISSING")
      }
      await zaloPersonalBridgeService.commitInboundEvent({
        workspaceId: row.workspaceId,
        integrationId: row.id,
        inboxId: row.inboxId,
        accountId: row.accountId,
        sequence: event.accountSequence,
        fenceToken: event.fenceToken,
        eventId: event.eventId,
        rawPayload: event.payload,
        ...(mappings ?? {}),
      })
    }
  })
}

export async function pollZaloPersonalBridge(): Promise<void> {
  if (!env.ZALO_PERSONAL_BRIDGE_POLL_ENABLED) {
    return
  }
  const qrSessions = await connectSessionService.listActiveByProvider({
    provider: "zalo_personal",
    limit: MAX_ACTIVE_QR_SESSIONS_PER_RUN,
    afterId: activeQrSessionCursor,
    requireProviderRuntime: true,
    includeExpiredFinalizing: true,
  })
  activeQrSessionCursor =
    qrSessions.length === MAX_ACTIVE_QR_SESSIONS_PER_RUN
      ? qrSessions.at(-1)?.id
      : undefined
  for (let index = 0; index < qrSessions.length; index += 10) {
    await Promise.all(
      qrSessions
        .slice(index, index + 10)
        .filter(
          (session) =>
            session.providerReference &&
            isZaloPersonalBridgeAccountEnabled(
              session.providerReference,
              "chatbotx_qr",
            ),
        )
        .map((session) =>
          withBlockedOwnerGuard(session.workspaceId, async () => {
            try {
              await pollZaloPersonalQrSession(session)
            } catch (err) {
              logger.error(
                { err, sessionId: session.id },
                "zalo personal QR session poll failed",
              )
            }
          }),
        ),
    )
  }

  const rows = await integrationZaloPersonalService.listActiveRuntimeRows(
    MAX_ACTIVE_ACCOUNTS_PER_RUN,
  )
  for (let index = 0; index < rows.length; index += 10) {
    await Promise.all(
      rows
        .slice(index, index + 10)
        .filter((row) =>
          isZaloPersonalBridgeAccountEnabled(row.accountId, row.auth.managedBy),
        )
        .map(pollAccount),
    )
  }
}
