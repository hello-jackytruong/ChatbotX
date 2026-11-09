import { describe, expect, it, vi } from "vitest"
import { ZaloPersonalBridgeService } from "../service"

const input = {
  workspaceId: "workspace-1",
  integrationId: "integration-1",
  inboxId: "inbox-1",
  messageId: "message-1",
  accountId: "account-1",
  bridgeUrl: "https://bridge.internal",
  keyId: "kid-1",
  secret: "secret-1",
  command: { commandId: "message-1", accountId: "account-1" },
}

describe("ZaloPersonalBridgeService.dispatchOutbound", () => {
  it("reconciles an unknown outcome without accepting the command twice", async () => {
    const row = {
      id: "outbox-1",
      status: "pending",
      attempts: 0,
      providerMessageId: null,
    }
    const repository = {
      createOutbound: vi.fn(async () => ({ ...row })),
      updateOutbound: vi.fn((update) => {
        row.status = update.status
        row.attempts += update.incrementAttempts ? 1 : 0
        row.providerMessageId = update.providerMessageId ?? null
        return Promise.resolve()
      }),
    }
    const acceptCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
    const reconcile = vi.fn().mockResolvedValue({
      status: "succeeded",
      result: { providerIds: { messageId: "provider-1" } },
    })
    const bindAccount = vi.fn().mockResolvedValue({ status: "bound" })
    const service = new ZaloPersonalBridgeService(repository as never, () => ({
      bindAccount,
      acceptCommand,
      getCommand: vi.fn(),
      reconcile,
    }))

    await expect(service.dispatchOutbound(input)).rejects.toThrow(
      "response lost",
    )
    repository.createOutbound.mockImplementation(async () => ({ ...row }))
    await expect(service.dispatchOutbound(input)).resolves.toEqual({
      messageIds: ["provider-1"],
      sentCount: 1,
    })

    expect(acceptCommand).toHaveBeenCalledOnce()
    expect(bindAccount).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      inboxId: "inbox-1",
    })
    expect(reconcile).toHaveBeenCalledWith({
      accountId: "account-1",
      commandId: "message-1",
    })
  })
})
