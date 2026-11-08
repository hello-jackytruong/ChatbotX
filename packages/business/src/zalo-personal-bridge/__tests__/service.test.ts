import { describe, expect, it, vi } from "vitest"
import {
  BridgeMappingConflictError,
  BridgeSequenceGapError,
} from "../repository"
import { ZaloPersonalBridgeService } from "../service"

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/

const baseInbound = {
  workspaceId: "workspace-1",
  integrationId: "integration-1",
  inboxId: "inbox-1",
  accountId: "account-1",
  sequence: "1",
  fenceToken: "1",
  eventId: "event-1",
  rawPayload: { text: "must-not-be-stored" },
}

describe("ZaloPersonalBridgeService", () => {
  it("uses the ChatbotX message identity as the stable outbound idempotency key", async () => {
    const createOutbound = vi.fn().mockImplementation(async (input) => input)
    const service = new ZaloPersonalBridgeService({ createOutbound } as never)

    const result = await service.enqueueOutbound({
      workspaceId: "workspace-1",
      integrationId: "integration-1",
      inboxId: "inbox-1",
      messageId: "message-1",
      accountId: "account-1",
      commandId: "command-1",
      payload: { kind: "sendMessage", text: "synthetic" },
    })

    expect(result).toMatchObject({
      idempotencyKey: "message-1",
      commandId: "command-1",
      payloadHash: expect.stringMatching(SHA256_HEX_PATTERN),
    })
  })

  it("dead-letters mapping conflicts by digest and does not expose message content", async () => {
    const addDeadLetter = vi.fn().mockResolvedValue(undefined)
    const service = new ZaloPersonalBridgeService({
      commitInbound: vi
        .fn()
        .mockRejectedValue(new BridgeMappingConflictError("message")),
      addDeadLetter,
    } as never)

    await expect(
      service.commitInboundEvent(baseInbound),
    ).rejects.toBeInstanceOf(BridgeMappingConflictError)
    expect(addDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "MAPPING_CONFLICT_MESSAGE",
        payloadDigest: expect.stringMatching(SHA256_HEX_PATTERN),
      }),
    )
    expect(JSON.stringify(addDeadLetter.mock.calls)).not.toContain(
      "must-not-be-stored",
    )
  })

  it("keeps the checkpoint before a sequence gap and requests reconciliation", async () => {
    const addDeadLetter = vi.fn()
    const service = new ZaloPersonalBridgeService({
      commitInbound: vi
        .fn()
        .mockRejectedValue(new BridgeSequenceGapError("2", "3")),
      addDeadLetter,
    } as never)

    await expect(
      service.commitInboundEvent({ ...baseInbound, sequence: "3" }),
    ).rejects.toMatchObject({ expected: "2", received: "3" })
    expect(addDeadLetter).not.toHaveBeenCalled()
  })
})
