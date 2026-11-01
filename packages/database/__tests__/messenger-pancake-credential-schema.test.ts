import { getTableConfig } from "drizzle-orm/pg-core"
import { describe, expect, test } from "vitest"
import { messengerPancakeCredentialModel } from "../src/schema"

describe("MessengerPancakeCredential", () => {
  const config = getTableConfig(messengerPancakeCredentialModel)

  test("stores one encrypted credential per Messenger integration", () => {
    expect(config.name).toBe("MessengerPancakeCredential")
    expect(
      config.indexes.find(
        (index) =>
          index.config.name ===
          "MessengerPancakeCredential_integrationMessengerId_key",
      )?.config.unique,
    ).toBe(true)

    const columns = config.columns.map((column) => column.name)
    expect(columns).toEqual(
      expect.arrayContaining([
        "workspaceId",
        "integrationMessengerId",
        "encryptedToken",
        "verifiedAt",
        "updatedByUserId",
      ]),
    )
    expect(columns).not.toEqual(
      expect.arrayContaining(["token", "pageAccessToken"]),
    )
  })

  test("indexes every foreign key for bounded cascade and set-null handling", () => {
    const indexNames = config.indexes.map((index) => index.config.name)

    expect(indexNames).toEqual(
      expect.arrayContaining([
        "MessengerPancakeCredential_workspaceId_idx",
        "MessengerPancakeCredential_integrationMessengerId_key",
        "MessengerPancakeCredential_updatedByUserId_idx",
      ]),
    )
  })
})
