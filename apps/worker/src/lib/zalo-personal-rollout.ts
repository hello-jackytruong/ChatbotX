import { env } from "../env"

const allowedAccounts = (allowlist: string): Set<string> =>
  new Set(
    allowlist
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  )

export const isZaloPersonalAccountAllowed = (input: {
  accountId: string
  enabled: boolean
  allowlist: string
}): boolean =>
  input.enabled && allowedAccounts(input.allowlist).has(input.accountId)

export const isZaloPersonalBridgeAccountEnabled = (
  accountId: string,
): boolean =>
  isZaloPersonalAccountAllowed({
    accountId,
    enabled: env.ZALO_PERSONAL_BRIDGE_ENABLED,
    allowlist: env.ZALO_PERSONAL_BRIDGE_ACCOUNT_ALLOWLIST,
  })
