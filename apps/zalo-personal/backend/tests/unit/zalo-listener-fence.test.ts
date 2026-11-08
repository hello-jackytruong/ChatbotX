import { describe, expect, it, vi } from 'vitest';
import { attachZaloListener } from '../../src/modules/zalo/zalo-listener-factory.js';

describe('Zalo listener fence', () => {
  it('drops callbacks from a listener that no longer owns the account lease', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const listener = {
      emit: vi.fn(),
      on: vi.fn((name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler)),
      start: vi.fn(),
    };
    const onDisconnected = vi.fn();
    attachZaloListener({
      accountId: 'account-1',
      api: { listener },
      io: null,
      isActive: () => false,
      userInfoCache: new Map(),
      onDisconnected,
    });

    await handlers.get('closed')?.(1006, 'stale socket');

    expect(onDisconnected).not.toHaveBeenCalled();
    expect(listener.start).toHaveBeenCalledWith({ retryOnClose: true });
  });
});
