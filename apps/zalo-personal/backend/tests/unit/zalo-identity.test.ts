import { describe, expect, it } from 'vitest';
import { isQrIdentityMismatch } from '../../src/modules/zalo/zalo-identity.js';

describe('Zalo QR identity validation', () => {
  it('rejects a different persisted identity but allows first login or the same identity', () => {
    expect(isQrIdentityMismatch('uid-original', 'uid-other')).toBe(true);
    expect(isQrIdentityMismatch('uid-original', 'uid-original')).toBe(false);
    expect(isQrIdentityMismatch(null, 'uid-first-connect')).toBe(false);
  });
});
