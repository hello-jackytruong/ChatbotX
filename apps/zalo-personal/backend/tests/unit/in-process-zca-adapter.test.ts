import { describe, expect, it, vi } from 'vitest';
import { InProcessZcaAdapter } from '../../src/modules/zalo-provider/in-process-zca-adapter.js';

describe('InProcessZcaAdapter', () => {
  it('constructs a self-listening, non-logging SDK session through the injected factory', () => {
    const session = { login: vi.fn(), loginQR: vi.fn() };
    const factory = vi.fn(() => session);
    const adapter = new InProcessZcaAdapter(factory);

    expect(adapter.createSession()).toBe(session);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      logging: false,
      selfListen: true,
      imageMetadataGetter: expect.any(Function),
    }));
  });
});
