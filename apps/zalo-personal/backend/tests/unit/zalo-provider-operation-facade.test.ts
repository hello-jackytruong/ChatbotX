import { describe, expect, it, vi } from 'vitest';
import { createProviderOperationFacade } from '../../src/modules/zalo-provider/operation-facade.js';

describe('provider operation transport facade', () => {
  it('keeps the exact in-process arguments and result when gateway mode is off', async () => {
    const direct = vi.fn().mockResolvedValue({ message: { msgId: 'direct-1' } });
    const remote = vi.fn();
    const facade = createProviderOperationFacade({ sendMessage: direct }, remote, () => false);

    await expect(facade.sendMessage('account-1', 'thread-1', 0, { msg: 'synthetic' }))
      .resolves.toEqual({ message: { msgId: 'direct-1' } });
    expect(direct).toHaveBeenCalledWith('account-1', 'thread-1', 0, { msg: 'synthetic' });
    expect(remote).not.toHaveBeenCalled();
  });

  it('sends the finite operation and unchanged arguments through the gateway transport', async () => {
    const direct = vi.fn();
    const remote = vi.fn().mockResolvedValue({ message: { msgId: 'remote-1' } });
    const facade = createProviderOperationFacade({ sendMessage: direct }, remote, () => true);

    await expect(facade.sendMessage('account-1', 'thread-1', 0, { msg: 'synthetic' }))
      .resolves.toEqual({ message: { msgId: 'remote-1' } });
    expect(remote).toHaveBeenCalledWith('sendMessage', 'account-1', [
      'thread-1', 0, { msg: 'synthetic' },
    ]);
    expect(direct).not.toHaveBeenCalled();
  });

  it('selects transport independently for each canary account', async () => {
    const direct = vi.fn().mockResolvedValue('direct');
    const remote = vi.fn().mockResolvedValue('remote');
    const facade = createProviderOperationFacade(
      { sendMessage: direct },
      remote,
      (accountId) => accountId === 'account-1',
    );

    await expect(facade.sendMessage('account-1')).resolves.toBe('remote');
    await expect(facade.sendMessage('account-2')).resolves.toBe('direct');
    expect(remote).toHaveBeenCalledOnce();
    expect(direct).toHaveBeenCalledOnce();
  });
});
