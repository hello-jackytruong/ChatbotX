import { describe, expect, it } from 'vitest';
import {
  BridgeAuthError,
  BridgeAuthenticator,
  InMemoryBridgeNonceStore,
  signBridgeRequest,
} from '../../src/modules/bridge/auth.js';

const nowMs = Date.parse('2026-11-08T00:00:00.000Z');
const secret = 'synthetic-bridge-secret';

function signedRequest(overrides: Partial<Parameters<typeof signBridgeRequest>[0]> = {}) {
  const input = {
    kid: 'client-1',
    method: 'POST',
    pathAndQuery: '/internal/bridge/v1/commands',
    timestamp: Math.floor(nowMs / 1000),
    nonce: 'nonce-1',
    body: { version: 1, accountId: 'account-1' },
    secret,
    ...overrides,
  };
  return { ...input, signature: signBridgeRequest(input) };
}

describe('bridge HMAC authentication', () => {
  it('accepts one valid scoped request and rejects its nonce replay', async () => {
    const nonces = new InMemoryBridgeNonceStore();
    const auth = new BridgeAuthenticator({
      find: async () => ({ kid: 'client-1', secret, accountIds: ['account-1'], active: true }),
    }, nonces, () => nowMs);
    const request = signedRequest();

    await expect(auth.verify(request, 'account-1')).resolves.toMatchObject({ kid: 'client-1' });
    await expect(auth.verify(request, 'account-1')).rejects.toMatchObject({ code: 'NONCE_REPLAY' });
  });

  it.each([
    ['BAD_SIGNATURE', signedRequest({ secret: 'wrong-secret' }), 'account-1'],
    ['TIMESTAMP_OUT_OF_RANGE', signedRequest({ timestamp: Math.floor(nowMs / 1000) - 61 }), 'account-1'],
    ['ACCOUNT_SCOPE_DENIED', signedRequest(), 'account-2'],
  ])('rejects %s without consuming an accepted command', async (code, request, accountId) => {
    const auth = new BridgeAuthenticator({
      find: async () => ({ kid: 'client-1', secret, accountIds: ['account-1'], active: true }),
    }, new InMemoryBridgeNonceStore(), () => nowMs);

    await expect(auth.verify(request, accountId)).rejects.toEqual(expect.objectContaining({ code }));
  });

  it('uses typed errors without exposing the bridge secret', () => {
    const error = new BridgeAuthError('BAD_SIGNATURE', 401);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it('accepts the previous secret during an explicit rotation overlap', async () => {
    const oldSecret = 'synthetic-previous-secret';
    const auth = new BridgeAuthenticator({
      find: async () => ({
        kid: 'client-1', secret, previousSecret: oldSecret,
        accountIds: ['account-1'], active: true,
      }),
    }, new InMemoryBridgeNonceStore(), () => nowMs);
    const request = signedRequest({ secret: oldSecret, nonce: 'rotation-nonce' });

    await expect(auth.verify(request, 'account-1')).resolves.toMatchObject({ kid: 'client-1' });
  });

  it('allows only signed onboarding cleanup retries after revocation, regardless of outage duration', async () => {
    const auth = new BridgeAuthenticator({
      find: async () => ({
        kid: 'client-1',
        secret,
        accountIds: [],
        active: false,
        revokedAt: new Date(nowMs - 30 * 24 * 60 * 60_000),
      }),
    }, new InMemoryBridgeNonceStore(), () => nowMs);
    const cleanupRequest = signedRequest({ nonce: 'cleanup-retry' });

    await expect(
      auth.verify(cleanupRequest, 'account-1', {
        allowRevokedForOnboardingCleanup: true,
      }),
    ).resolves.toMatchObject({ kid: 'client-1' });

    await expect(
      auth.verify(signedRequest({ nonce: 'normal-retry' }), 'account-1'),
    ).rejects.toMatchObject({ code: 'UNKNOWN_OR_REVOKED_KID' });
  });
});
