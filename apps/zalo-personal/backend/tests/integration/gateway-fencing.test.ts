import { describe, expect, it } from 'vitest';
import { AccountLeaseService, InMemoryAccountLeaseStore } from '../../src/modules/gateway/account-lease.js';
import { GatewayEventOutbox } from '../../src/modules/gateway/event-outbox.js';

describe('gateway account fencing', () => {
  it('accepts one owner and rejects all stale-fence event commits', async () => {
    const store = new InMemoryAccountLeaseStore(() => 1_000);
    const lease = new AccountLeaseService(store, 100);
    const attempts = await Promise.all(
      Array.from({ length: 10_000 }, (_, index) => lease.acquire('account-1', `gateway-${index}`)),
    );
    const winners = attempts.filter((candidate) => candidate.acquired);
    expect(winners).toHaveLength(1);

    const outbox = new GatewayEventOutbox(lease);
    store.advanceTo(1_101);
    await expect(outbox.append({
      eventId: 'expired-event', accountId: 'account-1', ownerId: winners[0].ownerId,
      fenceToken: winners[0].fenceToken, kind: 'message', payload: {}, occurredAt: new Date(1_101),
    })).rejects.toThrow('STALE_FENCE');
    const replacement = await lease.acquire('account-1', 'replacement');
    expect(replacement).toMatchObject({ acquired: true, fenceToken: 2n });

    await expect(outbox.append({
      eventId: 'stale-event', accountId: 'account-1', ownerId: winners[0].ownerId,
      fenceToken: winners[0].fenceToken, kind: 'message', payload: {}, occurredAt: new Date(1_000),
    })).rejects.toThrow('STALE_FENCE');
    await expect(outbox.append({
      eventId: 'fresh-event', accountId: 'account-1', ownerId: 'replacement',
      fenceToken: 2n, kind: 'message', payload: {}, occurredAt: new Date(1_101),
    })).resolves.toMatchObject({ accountSequence: 1n });
  });
});
