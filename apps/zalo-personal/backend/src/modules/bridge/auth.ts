import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type BridgeKey = {
  kid: string;
  secret: string;
  previousSecret?: string;
  accountIds: string[];
  active: boolean;
};

export type BridgeSignedRequest = {
  kid: string;
  method: string;
  pathAndQuery: string;
  timestamp: number;
  nonce: string;
  body: unknown;
  signature: string;
};

type BridgeKeyResolver = { find(kid: string): Promise<BridgeKey | null> };
type BridgeNonceStore = {
  consume(kid: string, nonce: string, expiresAt: Date): Promise<boolean>;
};

export class BridgeAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(code);
    this.name = 'BridgeAuthError';
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}

function canonicalPath(pathAndQuery: string): string {
  const url = new URL(pathAndQuery, 'http://bridge.internal');
  const entries = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  const query = new URLSearchParams(entries).toString();
  return `${url.pathname}${query ? `?${query}` : ''}`;
}

export function bridgeCanonicalRequest(input: Omit<BridgeSignedRequest, 'signature'> & { secret?: string }): string {
  const body = input.body == null ? '' : JSON.stringify(canonicalize(input.body));
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return [
    input.kid,
    input.method.toUpperCase(),
    canonicalPath(input.pathAndQuery),
    String(input.timestamp),
    input.nonce,
    bodyHash,
  ].join('\n');
}

export function signBridgeRequest(input: Omit<BridgeSignedRequest, 'signature'> & { secret: string }): string {
  return createHmac('sha256', input.secret).update(bridgeCanonicalRequest(input)).digest('hex');
}

export function signBridgeResponse(secret: string, correlationId: string, body: unknown): string {
  const bodyHash = createHash('sha256')
    .update(JSON.stringify(canonicalize(body)))
    .digest('hex');
  return createHmac('sha256', secret).update(`${correlationId}\n${bodyHash}`).digest('hex');
}

function signaturesEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export class InMemoryBridgeNonceStore implements BridgeNonceStore {
  private readonly nonces = new Map<string, number>();

  async consume(kid: string, nonce: string, expiresAt: Date): Promise<boolean> {
    const key = `${kid}:${nonce}`;
    if (this.nonces.has(key)) return false;
    this.nonces.set(key, expiresAt.getTime());
    return true;
  }
}

export class BridgeAuthenticator {
  constructor(
    private readonly keys: BridgeKeyResolver,
    private readonly nonces: BridgeNonceStore,
    private readonly now: () => number = Date.now,
    private readonly skewSeconds = 60,
  ) {}

  async verify(request: BridgeSignedRequest, accountId?: string): Promise<BridgeKey> {
    const nowSeconds = Math.floor(this.now() / 1000);
    if (!Number.isSafeInteger(request.timestamp)
      || Math.abs(nowSeconds - request.timestamp) > this.skewSeconds) {
      throw new BridgeAuthError('TIMESTAMP_OUT_OF_RANGE', 401);
    }
    const key = await this.keys.find(request.kid);
    if (!key?.active) throw new BridgeAuthError('UNKNOWN_OR_REVOKED_KID', 401);
    const matchedSecret = [key.secret, key.previousSecret]
      .filter((secret): secret is string => Boolean(secret))
      .find((secret) => signaturesEqual(
        request.signature,
        signBridgeRequest({ ...request, secret }),
      ));
    if (!matchedSecret) {
      throw new BridgeAuthError('BAD_SIGNATURE', 401);
    }
    if (accountId && !key.accountIds.includes(accountId)) {
      throw new BridgeAuthError('ACCOUNT_SCOPE_DENIED', 403);
    }
    const accepted = await this.nonces.consume(
      request.kid,
      request.nonce,
      new Date((request.timestamp + this.skewSeconds * 2) * 1000),
    );
    if (!accepted) throw new BridgeAuthError('NONCE_REPLAY', 409);
    return { ...key, secret: matchedSecret };
  }
}
