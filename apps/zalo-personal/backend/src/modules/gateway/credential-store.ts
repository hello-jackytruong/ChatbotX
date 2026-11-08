import { decrypt, encrypt } from '../../shared/crypto/aes-gcm.js';
import type { ProviderCredentials } from '../zalo-provider/client.js';

type CredentialRow = {
  sessionCiphertext: string | null;
  proxyCiphertext: string | null;
  sessionData: unknown;
  proxyUrl: string | null;
};

export interface CredentialRepository {
  read(accountId: string): Promise<CredentialRow | null>;
  write(accountId: string, data: Partial<CredentialRow>): Promise<void>;
}

const CIPHER_VERSION = 'v1';

export function sealGatewayCredential(value: string, keyHex: string): string {
  return `${CIPHER_VERSION}:${encrypt(value, keyHex)}`;
}

export function openGatewayCredential(value: string, keyHex: string): string {
  const [version, ...ciphertext] = value.split(':');
  if (version !== CIPHER_VERSION || ciphertext.length !== 3) {
    throw new Error('Unsupported or malformed gateway credential ciphertext');
  }
  return decrypt(ciphertext.join(':'), keyHex);
}

export class GatewayCredentialStore {
  constructor(
    private readonly repository: CredentialRepository,
    private readonly keyHex: string,
  ) {
    if (!/^[a-fA-F0-9]{64}$/.test(keyHex)) {
      throw new Error('Gateway credential key must be exactly 32 bytes encoded as hex');
    }
  }

  async dualWrite(
    accountId: string,
    session: ProviderCredentials,
    proxyUrl: string | null,
  ): Promise<void> {
    await this.repository.write(accountId, {
      sessionCiphertext: sealGatewayCredential(JSON.stringify(session), this.keyHex),
      proxyCiphertext: proxyUrl == null ? null : sealGatewayCredential(proxyUrl, this.keyHex),
      sessionData: session,
      proxyUrl,
    });
  }

  async read(accountId: string): Promise<{ session: ProviderCredentials | null; proxyUrl: string | null } | null> {
    const row = await this.repository.read(accountId);
    if (!row) return null;

    if (row.sessionCiphertext) {
      const session = JSON.parse(openGatewayCredential(row.sessionCiphertext, this.keyHex)) as ProviderCredentials;
      const proxyUrl = row.proxyCiphertext ? openGatewayCredential(row.proxyCiphertext, this.keyHex) : row.proxyUrl;
      return { session, proxyUrl };
    }

    return {
      session: row.sessionData as ProviderCredentials | null,
      proxyUrl: row.proxyUrl,
    };
  }
}
