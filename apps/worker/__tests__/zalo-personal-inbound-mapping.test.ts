import { describe, expect, it } from "vitest"
import {
  buildZaloPersonalInboundMappings,
  parseZaloPersonalInboundCompletion,
} from "../src/lib/zalo-personal-inbound-mapping"

const completion = {
  messageId: "message-1",
  conversationId: "conversation-1",
  contactId: "contact-1",
  direction: "inbound" as const,
}

describe("Zalo Personal inbound mapping", () => {
  it("maps provider identities without changing the legacy payload", () => {
    const event = {
      version: 1 as const,
      eventId: "event-1",
      accountId: "account-1",
      accountSequence: "1",
      fenceToken: "7",
      kind: "message" as const,
      providerEventId: "provider-message-1",
      occurredAt: "2026-11-08T00:00:00.000Z",
      payload: {
        event: "chat:message",
        payload: {
          conversationId: "provider-thread-1",
          message: {
            senderType: "contact",
            senderUid: "provider-contact-1",
            cliMsgId: "provider-client-1",
          },
        },
      },
    }
    const before = structuredClone(event.payload)

    expect(buildZaloPersonalInboundMappings(event, completion)).toEqual({
      thread: {
        providerId: "provider-thread-1",
        conversationId: "conversation-1",
      },
      contact: {
        providerId: "provider-contact-1",
        contactId: "contact-1",
      },
      message: {
        providerId: "provider-message-1",
        providerClientId: "provider-client-1",
        messageId: "message-1",
        direction: "inbound",
      },
    })
    expect(event.payload).toEqual(before)
  })

  it("maps a self echo to the remote conversation rather than the account", () => {
    expect(
      buildZaloPersonalInboundMappings(
        {
          version: 1,
          eventId: "event-2",
          accountId: "account-1",
          accountSequence: "2",
          fenceToken: "7",
          kind: "message",
          providerEventId: "provider-message-2",
          occurredAt: "2026-11-08T00:00:01.000Z",
          payload: {
            payload: {
              conversationId: "provider-contact-2",
              message: { senderType: "self", senderUid: "account-1" },
            },
          },
        },
        { ...completion, direction: "outbound" },
      ),
    ).toMatchObject({
      contact: { providerId: "provider-contact-2" },
      message: { direction: "outbound" },
    })
  })

  it("fails closed when the queue result or provider identity is incomplete", () => {
    expect(
      parseZaloPersonalInboundCompletion({ messageId: "message-1" }),
    ).toBeNull()
    expect(
      buildZaloPersonalInboundMappings(
        {
          version: 1,
          eventId: "event-3",
          accountId: "account-1",
          accountSequence: "3",
          fenceToken: "7",
          kind: "message",
          providerEventId: null,
          occurredAt: "2026-11-08T00:00:02.000Z",
          payload: { payload: {} },
        },
        completion,
      ),
    ).toBeNull()
  })
})
