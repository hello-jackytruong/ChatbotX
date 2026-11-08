import { afterEach, describe, expect, it, vi } from 'vitest';
import { usesRemoteGateway } from '../../src/modules/zalo-provider/remote-operation.js';

describe('gateway account routing', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('fails closed unless mode, claims and exact account allowlist all match', () => {
    vi.stubEnv('ZALO_PERSONAL_RUNTIME_ROLE', 'facade');
    vi.stubEnv('ZALO_PERSONAL_PROVIDER_MODE', 'gateway');
    vi.stubEnv('ZALO_GATEWAY_CLAIMS_ENABLED', 'true');
    vi.stubEnv('ZALO_GATEWAY_ACCOUNT_ALLOWLIST', ' account-1,account-3 ');

    expect(usesRemoteGateway('account-1')).toBe(true);
    expect(usesRemoteGateway('account-2')).toBe(false);

    vi.stubEnv('ZALO_GATEWAY_CLAIMS_ENABLED', 'false');
    expect(usesRemoteGateway('account-1')).toBe(false);
  });

  it('never routes the gateway process back through its own command inbox', () => {
    vi.stubEnv('ZALO_PERSONAL_RUNTIME_ROLE', 'gateway');
    vi.stubEnv('ZALO_PERSONAL_PROVIDER_MODE', 'gateway');
    vi.stubEnv('ZALO_GATEWAY_CLAIMS_ENABLED', 'true');
    vi.stubEnv('ZALO_GATEWAY_ACCOUNT_ALLOWLIST', 'account-1');

    expect(usesRemoteGateway('account-1')).toBe(false);
  });
});
