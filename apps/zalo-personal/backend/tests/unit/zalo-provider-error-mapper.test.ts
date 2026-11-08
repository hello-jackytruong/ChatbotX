import { describe, expect, it } from 'vitest';
import { mapProviderError } from '../../src/modules/zalo-provider/error-mapper.js';

describe('provider error mapper', () => {
  it('preserves legacy error identity without serializing secrets', () => {
    const result = mapProviderError('command-1', Object.assign(new Error('cookie=private-value'), {
      code: 'SESSION_EXPIRED',
      statusCode: 401,
      cookie: 'private-value',
    }));

    expect(result).toEqual({
      version: 1,
      commandId: 'command-1',
      status: 'rejected',
      providerIds: {},
      errorCode: 'SESSION_EXPIRED',
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain('private-value');
  });
});
