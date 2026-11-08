import { describe, expect, it, vi } from 'vitest';
import { GatewaySocketOutbox } from '../../src/modules/gateway/gateway-socket-outbox.js';

describe('gateway Socket.IO outbox adapter', () => {
  it('records the exact room, event and payload under the account fence', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const adapter = new GatewaySocketOutbox(
      { append },
      (accountId) => accountId === 'account-1'
        ? { ownerId: 'gateway-a', fenceToken: 7n }
        : null,
    );
    const scoped = adapter.forAccount('account-1');
    const payload = { accountId: 'account-1', messageId: 'message-1' };

    scoped.to('org:org-1').emit('chat:message', payload);
    await adapter.drain();

    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-1',
      ownerId: 'gateway-a',
      fenceToken: 7n,
      kind: 'message',
      payload: { room: 'org:org-1', event: 'chat:message', payload },
    }));
  });

  it('drops stale callbacks after lease loss before they can reach the outbox', async () => {
    const append = vi.fn();
    const adapter = new GatewaySocketOutbox({ append }, () => null);

    adapter.forAccount('account-1').emit('zalo:disconnected', { accountId: 'account-1' });
    await adapter.drain();

    expect(append).not.toHaveBeenCalled();
  });

  it('retries a transient append failure without changing the event identity', async () => {
    const append = vi.fn()
      .mockRejectedValueOnce(new Error('temporary database failure'))
      .mockResolvedValue(undefined);
    const adapter = new GatewaySocketOutbox(
      { append },
      () => ({ ownerId: 'gateway-a', fenceToken: 7n }),
      [0],
    );

    adapter.forAccount('account-1').emit('chat:message', { accountId: 'account-1' });
    await adapter.drain();

    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1]?.[0]).toEqual(append.mock.calls[0]?.[0]);
  });

  it('surfaces a permanent append failure', async () => {
    const append = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const adapter = new GatewaySocketOutbox(
      { append },
      () => ({ ownerId: 'gateway-a', fenceToken: 7n }),
      [],
    );

    adapter.forAccount('account-1').emit('chat:message', { accountId: 'account-1' });

    await expect(adapter.waitForFailure()).rejects.toThrow('database unavailable');
    await expect(adapter.drain()).rejects.toThrow('database unavailable');
  });
});
