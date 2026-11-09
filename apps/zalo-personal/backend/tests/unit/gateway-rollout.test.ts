import { describe, expect, it } from 'vitest';
import {
  eligibleGatewayAccountIds,
  readGatewayRolloutConfig,
} from '../../src/modules/gateway/rollout.js';

describe('gateway rollout gates', () => {
  it('owns no account by default and only exact allowlisted accounts when enabled', () => {
    const disabled = readGatewayRolloutConfig({});
    expect([...eligibleGatewayAccountIds([{ id: 'one', onboardingManaged: false }], disabled)]).toEqual([]);

    const enabled = readGatewayRolloutConfig({
      ZALO_GATEWAY_CLAIMS_ENABLED: 'true',
      ZALO_GATEWAY_COMMAND_CLAIMS_ENABLED: 'true',
      ZALO_GATEWAY_ACCOUNT_ALLOWLIST: ' one, two ',
    });
    expect([...eligibleGatewayAccountIds([
      { id: 'one', onboardingManaged: false },
      { id: 'three', onboardingManaged: false },
    ], enabled)]).toEqual([
      'one',
    ]);
    expect(enabled.commandClaimsEnabled).toBe(true);
  });

  it('owns dynamically provisioned accounts only behind the onboarding gate', () => {
    const config = readGatewayRolloutConfig({
      ZALO_GATEWAY_CLAIMS_ENABLED: 'true',
      ZALO_GATEWAY_ONBOARDING_ENABLED: 'true',
    });
    expect([...eligibleGatewayAccountIds([
      { id: 'managed', onboardingManaged: true },
      { id: 'legacy', onboardingManaged: false },
    ], config)]).toEqual(['managed']);
  });
});
