import { PgDialect } from "drizzle-orm/pg-core"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({ execute: vi.fn() }))

vi.mock("../src/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client")>()
  return { ...actual, db: { execute: mocks.execute } }
})

const { messengerProfileBackfillRunRepository } = await import(
  "../src/repositories/messenger-profile-backfill-run/repository"
)

const dialect = new PgDialect()

const renderQuery = (sqlArg: unknown) => {
  const { sql: text, params } = dialect.sqlToQuery(sqlArg as never)
  return { text: text.replace(/\s+/g, " ").trim(), params }
}

beforeEach(() => vi.clearAllMocks())

describe("messenger profile backfill run repository", () => {
  test("lets overwrite mode scan contacts that already have complete profiles", async () => {
    mocks.execute.mockResolvedValue({ rows: [] })

    await messengerProfileBackfillRunRepository.listCandidates({
      workspaceId: "workspace-1",
      inboxId: "inbox-1",
      cursorContactInboxId: null,
      limit: 20,
      overwriteExisting: true,
    })

    const query = renderQuery(mocks.execute.mock.calls[0]?.[0])
    expect(query.text).toContain("AND ($5::boolean OR (")
    expect(query.params).toEqual([
      "inbox-1",
      "workspace-1",
      null,
      null,
      true,
      20,
    ])
  })

  test("overwrites supplied fields and preserves fields omitted by the provider", async () => {
    mocks.execute.mockResolvedValue({
      rows: [{ avatarUpdated: false }],
    })

    await expect(
      messengerProfileBackfillRunRepository.overwriteProfile({
        workspaceId: "workspace-1",
        contactId: "contact-1",
        firstName: "New",
      }),
    ).resolves.toEqual({ updated: true, avatarUpdated: false })

    const query = renderQuery(mocks.execute.mock.calls[0]?.[0])
    expect(query.text).toContain(
      '"firstName" = COALESCE($1, "firstName"), "lastName" = COALESCE($2, "lastName")',
    )
    expect(query.params).toContain("New")
    expect(query.params).not.toContain("")
  })
})
