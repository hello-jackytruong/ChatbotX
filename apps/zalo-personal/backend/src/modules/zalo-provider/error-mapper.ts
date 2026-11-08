import type { ProviderResultV1 } from './contracts.js';

type ProviderLikeError = {
  code?: unknown;
  message?: unknown;
  name?: unknown;
  statusCode?: unknown;
};

const rejectedCodes = new Set([
  'INVALID_PARAMS',
  'NOT_CONNECTED',
  'RATE_LIMITED',
  'SESSION_EXPIRED',
]);

export function mapProviderError(commandId: string, error: unknown): ProviderResultV1 {
  const candidate = error as ProviderLikeError;
  const errorCode = typeof candidate?.code === 'string' && candidate.code.length > 0
    ? candidate.code
    : 'PROVIDER_ERROR';
  const retryable = errorCode === 'NOT_CONNECTED' || errorCode === 'RATE_LIMITED';

  const legacyMessage = candidate?.name === 'ZaloOpError' && typeof candidate.message === 'string'
    ? candidate.message
      .replace(/(cookie|token|proxy|authorization)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
      .slice(0, 500)
    : undefined;

  return {
    version: 1,
    commandId,
    status: rejectedCodes.has(errorCode) ? 'rejected' : 'failed',
    providerIds: {},
    errorCode,
    retryable,
    ...(legacyMessage ? { payload: { legacyMessage } } : {}),
  };
}
