import { providerOperationNames, type ProviderOperationName } from './contracts.js';

type ProviderOperation = (accountId: string, ...args: any[]) => Promise<any>;
type RemoteOperation = (
  kind: ProviderOperationName,
  accountId: string,
  args: unknown[],
) => Promise<unknown>;

const allowedOperations = new Set<string>(providerOperationNames);

export function createProviderOperationFacade<T extends Record<string, ProviderOperation>>(
  directOperations: T,
  remoteOperation: RemoteOperation,
  useRemote: (accountId: string) => boolean,
): T {
  const entries = Object.entries(directOperations).map(([kind, direct]) => {
    if (!allowedOperations.has(kind)) {
      throw new Error(`Provider operation is not declared in v1 contract: ${kind}`);
    }
    const operationKind = kind as ProviderOperationName;
    const operation: ProviderOperation = (accountId, ...args) => useRemote(accountId)
      ? remoteOperation(operationKind, accountId, args)
      : direct(accountId, ...args);
    return [kind, operation];
  });
  return Object.fromEntries(entries) as T;
}
