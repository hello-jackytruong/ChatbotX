import { PgDialect } from "drizzle-orm/pg-core"
import { beforeEach, describe, expect, test, vi } from "vitest"
import type { DatabaseClient } from "../src/client"
import { messengerPancakeCredentialRepository } from "../src/repositories/messenger-pancake-credential/repository"
import { messengerPancakeCredentialModel } from "../src/schema"

const dialect = new PgDialect()
const REF = { workspaceId: "ws-1", integrationMessengerId: "im-1" }
const ENCRYPTED = {
  v: 1 as const,
  iv: "0".repeat(24),
  text: "ciphertext",
  tag: "0".repeat(32),
}

const buildSelectTx = (rows: unknown[]) => {
  const limit = vi.fn().mockResolvedValue(rows)
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  const select = vi.fn().mockReturnValue({ from })
  return { tx: { select } as unknown as DatabaseClient, select, where }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("messengerPancakeCredentialRepository", () => {
  test("status read is workspace scoped and never selects encryptedToken", async () => {
    const row = {
      id: "pc-1",
      ...REF,
      verifiedAt: new Date("2026-11-01T00:00:00Z"),
      updatedAt: new Date("2026-11-01T00:00:00Z"),
      updatedByUserId: "user-1",
    }
    const { tx, select, where } = buildSelectTx([row])

    await expect(
      messengerPancakeCredentialRepository.findStatus(REF, tx),
    ).resolves.toEqual(row)

    const projection = select.mock.calls[0]?.[0]
    expect(projection).not.toHaveProperty("encryptedToken")
    expect(dialect.sqlToQuery(where.mock.calls[0][0]).params).toEqual([
      "ws-1",
      "im-1",
    ])
  })

  test("backend read selects only identity and encrypted token", async () => {
    const { tx, select } = buildSelectTx([
      { id: "pc-1", ...REF, encryptedToken: ENCRYPTED },
    ])

    await messengerPancakeCredentialRepository.findEncryptedForBackend(REF, tx)

    expect(Object.keys(select.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      "encryptedToken",
      "id",
      "integrationMessengerId",
      "workspaceId",
    ])
  })

  test("upserts the verified envelope on the integration unique key", async () => {
    const row = { id: "pc-1", ...REF }
    const returning = vi.fn().mockResolvedValue([row])
    const onConflictDoUpdate = vi.fn().mockReturnValue({ returning })
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate })
    const insert = vi.fn().mockReturnValue({ values })
    const tx = { insert } as unknown as DatabaseClient
    const verifiedAt = new Date("2026-11-01T00:00:00Z")

    await expect(
      messengerPancakeCredentialRepository.upsert(
        {
          ...REF,
          encryptedToken: ENCRYPTED,
          verifiedAt,
          updatedByUserId: "user-1",
        },
        tx,
      ),
    ).resolves.toBe(row)

    expect(insert).toHaveBeenCalledWith(messengerPancakeCredentialModel)
    expect(values).toHaveBeenCalledWith({
      ...REF,
      encryptedToken: ENCRYPTED,
      verifiedAt,
      updatedByUserId: "user-1",
    })
    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: messengerPancakeCredentialModel.integrationMessengerId,
      set: {
        encryptedToken: ENCRYPTED,
        verifiedAt,
        updatedByUserId: "user-1",
      },
    })
  })
})
