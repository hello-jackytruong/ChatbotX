import { afterEach, describe, expect, it } from 'vitest';
import { installBigIntJsonSerializer } from '../../src/shared/json-bigint.js';

const originalToJSON = (BigInt.prototype as unknown as { toJSON?: () => string }).toJSON;

afterEach(() => {
  const prototype = BigInt.prototype as unknown as { toJSON?: () => string };
  if (originalToJSON) {
    prototype.toJSON = originalToJSON;
  } else {
    delete prototype.toJSON;
  }
});

describe('installBigIntJsonSerializer', () => {
  it('serializes gateway fence tokens and sequences as strings', () => {
    installBigIntJsonSerializer();

    expect(JSON.stringify({ fenceToken: 3n, sequence: 7n })).toBe(
      '{"fenceToken":"3","sequence":"7"}',
    );
  });
});
