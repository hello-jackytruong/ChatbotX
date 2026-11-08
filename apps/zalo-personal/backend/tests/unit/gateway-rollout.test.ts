import { describe, expect, it } from 'vitest';
import {
  eligibleGatewayAccountIds,
  readGatewayRolloutConfig,
} from '../../src/modules/gateway/rollout.js';

describe('gateway rollout gates', () => {
  it('owns no account by default and only exact allowlisted accounts when enabled', () => {
    const disabled = readGatewayRolloutConfig({});
    expect([...eligibleGatewayAccountIds(['one'], disabled)]).toEqual([]);

    const enabled = readGatewayRolloutConfig({
      ZALO_GATEWAY_CLAIMS_ENABLED: 'true',
      ZALO_GATEWAY_COMMAND_CLAIMS_ENABLED: 'true',
      ZALO_GATEWAY_ACCOUNT_ALLOWLIST: ' one, two ',
    });
    expect([...eligibleGatewayAccountIds(['one', 'three'], enabled)]).toEqual([
      'one',
    ]);
    expect(enabled.commandClaimsEnabled).toBe(true);
  });
});
