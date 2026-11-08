import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ZaloPersonalBridgeClient } from "../src/bridge-client"
import {
  buildSendFlowStepCommand,
  buildSendMessageCommand,
  parseInboundBridgeEvent,
} from "../src/handlers/message"
import { integration } from "../src/integration"
import { zaloPersonalAuthSchema } from "../src/schema/definition"

describe("Zalo Personal bridge contracts", () => {
  beforeEach(() => {
    vi.stubEnv(
      "ZALO_PERSONAL_BRIDGE_ALLOWED_ORIGINS",
      "https://bridge.example.test",
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("registers a channel distinct from the existing Zalo OA provider", () => {
    expect(integration.name).toBe("zalo_personal")
    expect(integration.name).not.toBe("zalo")
  })

  it("rejects non-HTTP bridge protocols", () => {
    expect(() =>
      zaloPersonalAuthSchema.parse({
        authType: "custom",
        accountId: "account-1",
        bridgeUrl: "file:///etc/passwd",
        keyId: "kid-1",
        secret: "secret-1",
      }),
    ).toThrow("Bridge URL must use HTTP or HTTPS")
  })

  it("does not follow bridge redirects", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ready: true, version: 1 }))
    const client = new ZaloPersonalBridgeClient(
      {
        baseUrl: "https://bridge.example.test",
        keyId: "kid-1",
        secret: "secret-1",
      },
      fetcher,
    )

    await expect(client.health()).rejects.toMatchObject({
      code: "INVALID_BRIDGE_RESPONSE_SIGNATURE",
    })
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: "error" }),
    )
  })

  it("rejects bridge origins outside deployment policy before fetch", () => {
    expect(
      () =>
        new ZaloPersonalBridgeClient({
          baseUrl: "http://127.0.0.1:3000",
          keyId: "kid-1",
          secret: "secret-1",
        }),
    ).toThrow("ZALO_PERSONAL_BRIDGE_ORIGIN_NOT_ALLOWED")
  })

  it("reuses the stored flow message identity across retries", () => {
    const input = {
      accountId: "account-1",
      contactId: "contact-1",
      messageId: "flow-message-1",
      step: { stepType: "sendText", text: "hello from flow" },
      now: new Date("2026-11-08T00:00:00.000Z"),
    }

    expect(buildSendFlowStepCommand(input)).toEqual(
      buildSendFlowStepCommand(input),
    )
    expect(buildSendFlowStepCommand(input)).toMatchObject({
      commandId: "flow-message-1",
      idempotencyKey: "flow-message-1",
      kind: "sendMessage",
      payload: { args: ["contact-1", 0, { msg: "hello from flow" }] },
    })
  })
  it("uses the ChatbotX message id for both command and idempotency identity", () => {
    const command = buildSendMessageCommand({
      accountId: "account-1",
      contactId: "contact-1",
      message: {
        id: "message-1",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        contentType: "text",
        messageType: "outgoing",
        text: "hello",
      },
      now: new Date("2026-11-08T00:00:00.000Z"),
    })

    expect(command).toMatchObject({
      version: 1,
      commandId: "message-1",
      idempotencyKey: "message-1",
      accountId: "account-1",
      kind: "sendMessage",
      payload: { args: ["contact-1", 0, { msg: "hello" }] },
    })
  })

  it("projects the immutable legacy socket payload without changing its object", () => {
    const rawPayload = {
      room: "org:org-1",
      event: "chat:message",
      payload: {
        accountId: "account-1",
        conversationId: "zalo-conversation-1",
        message: {
          id: "legacy-row-1",
          zaloMsgId: "provider-message-1",
          senderType: "contact",
          senderUid: "contact-1",
          senderName: "Synthetic User",
          content: "hello",
          contentType: "text",
          attachments: [],
        },
      },
    }
    const before = structuredClone(rawPayload)

    expect(
      parseInboundBridgeEvent({
        version: 1,
        eventId: "event-1",
        accountId: "account-1",
        accountSequence: "1",
        fenceToken: "7",
        kind: "message",
        providerEventId: "provider-message-1",
        payload: rawPayload,
        occurredAt: "2026-11-08T00:00:00.000Z",
      }),
    ).toMatchObject({
      contact: { sourceId: "contact-1", firstName: "Synthetic User" },
      message: {
        sourceId: "provider-message-1",
        messageType: "incoming",
        text: "hello",
      },
    })
    expect(rawPayload).toEqual(before)
  })

  it("rejects non-message socket events from the receive-message path", () => {
    expect(
      parseInboundBridgeEvent({
        version: 1,
        eventId: "event-2",
        accountId: "account-1",
        accountSequence: "2",
        fenceToken: "7",
        kind: "delivered",
        providerEventId: null,
        payload: { room: null, event: "zalo:message-status", payload: {} },
        occurredAt: "2026-11-08T00:00:01.000Z",
      }),
    ).toBeNull()
  })

  it("uses the remote conversation identity for outgoing self echoes", () => {
    const parsed = parseInboundBridgeEvent({
      version: 1,
      eventId: "event-3",
      accountId: "account-1",
      accountSequence: "3",
      fenceToken: "7",
      kind: "message",
      providerEventId: "provider-message-3",
      payload: {
        event: "chat:message",
        payload: {
          conversationId: "remote-contact-1",
          message: {
            zaloMsgId: "provider-message-3",
            senderType: "self",
            senderUid: "account-1",
            content: "outgoing echo",
            contentType: "text",
          },
        },
      },
      occurredAt: "2026-11-08T00:00:02.000Z",
    })

    expect(parsed).toMatchObject({
      contact: { sourceId: "remote-contact-1" },
      message: { messageType: "outgoing" },
    })
  })
})
