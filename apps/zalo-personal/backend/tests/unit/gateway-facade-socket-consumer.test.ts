import { describe, expect, it, vi } from 'vitest';
import { GatewayFacadeSocketConsumer } from '../../src/modules/gateway/gateway-facade-socket-consumer.js';

describe('gateway facade socket consumer', () => {
  it('emits committed socket events with the exact room, name, payload and order', async () => {
    const toEmit = vi.fn();
    const bareEmit = vi.fn();
    const io = { emit: bareEmit, to: vi.fn(() => ({ emit: toEmit })) };
    const repository = {
      claimBatch: vi.fn().mockResolvedValue([
        { accountSequence: 1n, kind: 'message', payload: { room: 'org:1', event: 'first', payload: { n: 1 } } },
        { accountSequence: 2n, kind: 'seen', payload: { room: null, event: 'second', payload: { n: 2 } } },
      ]),
      checkpoint: vi.fn().mockResolvedValue(undefined),
      listAccounts: vi.fn().mockResolvedValue(['account-1']),
    };
    const consumer = new GatewayFacadeSocketConsumer(repository, io as never);

    await expect(consumer.runOnce()).resolves.toBe(2);
    expect(io.to).toHaveBeenCalledWith('org:1');
    expect(toEmit).toHaveBeenCalledWith('first', { n: 1 });
    expect(bareEmit).toHaveBeenCalledWith('second', { n: 2 });
    expect(repository.claimBatch).toHaveBeenCalledWith('zalo-personal-facade', 'account-1', 100);
    expect(repository.checkpoint.mock.calls).toEqual([
      ['zalo-personal-facade', 'account-1', 1n],
      ['zalo-personal-facade', 'account-1', 2n],
    ]);
  });

  it('does not checkpoint an event when emitting it throws', async () => {
    const repository = {
      claimBatch: vi.fn().mockResolvedValue([
        { accountSequence: 1n, kind: 'message', payload: { room: null, event: 'message', payload: {} } },
      ]),
      checkpoint: vi.fn().mockResolvedValue(undefined),
      listAccounts: vi.fn().mockResolvedValue(['account-1']),
    };
    const io = { emit: vi.fn(() => { throw new Error('socket unavailable'); }), to: vi.fn() };
    const consumer = new GatewayFacadeSocketConsumer(repository, io as never);

    await expect(consumer.runOnce()).rejects.toThrow('socket unavailable');
    expect(repository.checkpoint).not.toHaveBeenCalled();
  });
});
