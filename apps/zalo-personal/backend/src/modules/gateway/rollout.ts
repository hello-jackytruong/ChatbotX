export type GatewayRolloutConfig = {
  claimsEnabled: boolean;
  commandClaimsEnabled: boolean;
  accountAllowlist: ReadonlySet<string>;
};

export function readGatewayRolloutConfig(
  env: NodeJS.ProcessEnv,
): GatewayRolloutConfig {
  return {
    claimsEnabled: env.ZALO_GATEWAY_CLAIMS_ENABLED === 'true',
    commandClaimsEnabled: env.ZALO_GATEWAY_COMMAND_CLAIMS_ENABLED === 'true',
    accountAllowlist: new Set(
      (env.ZALO_GATEWAY_ACCOUNT_ALLOWLIST || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  };
}

export function eligibleGatewayAccountIds(
  accountIds: readonly string[],
  config: GatewayRolloutConfig,
): Set<string> {
  return new Set(
    config.claimsEnabled
      ? accountIds.filter((accountId) => config.accountAllowlist.has(accountId))
      : [],
  );
}
