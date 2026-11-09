import { describe, expect, it, vi } from 'vitest';
import { PrismaBridgeAccountBindingRepository } from '../../src/modules/bridge/prisma-account-binding.js';

const input = {
  kid: 'client-1',
  accountId: 'account-1',
  workspaceId: 'workspace-1',
  inboxId: 'inbox-1',
};

describe('PrismaBridgeAccountBindingRepository', () => {
  it('binds an unbound mapping or accepts the same binding again', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ id: 'mapping-1' }]);
    const repository = new PrismaBridgeAccountBindingRepository({
      $queryRaw: queryRaw,
    } as never);

    await expect(repository.bind(input)).resolves.toBe('bound');
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it('reports a conflict without overwriting another workspace or inbox', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'mapping-1' }]);
    const repository = new PrismaBridgeAccountBindingRepository({
      $queryRaw: queryRaw,
    } as never);

    await expect(repository.bind(input)).resolves.toBe('conflict');
  });

  it('reports a missing scoped mapping without creating one implicitly', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const repository = new PrismaBridgeAccountBindingRepository({
      $queryRaw: queryRaw,
    } as never);

    await expect(repository.bind(input)).resolves.toBe('not_found');
  });
});
