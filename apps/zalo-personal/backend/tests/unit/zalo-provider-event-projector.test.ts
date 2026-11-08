import { describe, expect, it } from 'vitest';
import { ProviderEventProjector } from '../../src/modules/zalo-provider/event-projector.js';

describe('ProviderEventProjector', () => {
  it('orders events per account and drops callbacks from a superseded epoch', () => {
    const projector = new ProviderEventProjector(() => '2026-11-07T00:00:00.000Z', (sequence) => `event-${sequence}`);
    const epoch = projector.beginEpoch('account-1');

    expect(projector.project('account-1', epoch, 'message', { body: 'synthetic' }))
      .toMatchObject({ eventId: 'event-1', accountSequence: 1, kind: 'message' });
    const currentEpoch = projector.beginEpoch('account-1');
    expect(projector.project('account-1', epoch, 'typing', {})).toBeNull();
    expect(projector.project('account-1', currentEpoch, 'typing', {}))
      .toMatchObject({ eventId: 'event-2', accountSequence: 2, kind: 'typing' });
  });
});
