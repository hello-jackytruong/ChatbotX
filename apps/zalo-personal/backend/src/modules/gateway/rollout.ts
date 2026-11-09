export type GatewayRolloutConfig = {
  claimsEnabled: boolean;
  commandClaimsEnabled: boolean;
  onboardingClaimsEnabled: boolean;
  accountAllowlist: ReadonlySet<string>;
};

export function readGatewayRolloutConfig(
  env: NodeJS.ProcessEnv,
): GatewayRolloutConfig {
  return {
    claimsEnabled: env.ZALO_GATEWAY_CLAIMS_ENABLED === 'true',
    commandClaimsEnabled: env.ZALO_GATEWAY_COMMAND_CLAIMS_ENABLED === 'true',
    onboardingClaimsEnabled: env.ZALO_GATEWAY_ONBOARDING_ENABLED === 'true',
    accountAllowlist: new Set(
      (env.ZALO_GATEWAY_ACCOUNT_ALLOWLIST || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  };
}

export function eligibleGatewayAccountIds(
  accounts: readonly { id: string; onboardingManaged: boolean }[],
  config: GatewayRolloutConfig,
): Set<string> {
  return new Set(
    config.claimsEnabled
      ? accounts
        .filter((account) => config.accountAllowlist.has(account.id)
          || (config.onboardingClaimsEnabled && account.onboardingManaged))
        .map((account) => account.id)
      : [],
  );
}
