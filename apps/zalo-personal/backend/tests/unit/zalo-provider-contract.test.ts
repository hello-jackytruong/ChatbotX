import { describe, expect, it } from 'vitest';
import {
  providerCommandSchema,
  providerEventSchema,
  providerResultSchema,
} from '../../src/modules/zalo-provider/contracts.js';

describe('Zalo provider v1 contracts', () => {
  it('accepts a complete versioned command envelope', () => {
    expect(providerCommandSchema.parse({
      version: 1,
      commandId: 'command-1',
      idempotencyKey: 'message-1',
      accountId: 'account-1',
      kind: 'sendMessage',
      payload: { threadId: 'thread-1', threadType: 0, message: { msg: 'synthetic' } },
      requestedAt: '2026-11-07T00:00:00.000Z',
      deadlineAt: '2026-11-07T00:00:30.000Z',
      traceId: 'trace-1',
    })).toMatchObject({ version: 1, kind: 'sendMessage' });
  });

  it.each([
    { version: 2, commandId: 'c', idempotencyKey: 'i', accountId: 'a', kind: 'sendMessage', payload: {}, requestedAt: '2026-11-07T00:00:00.000Z', deadlineAt: '2026-11-07T00:00:30.000Z', traceId: 't' },
    { version: 1, commandId: '', idempotencyKey: 'i', accountId: 'a', kind: 'sendMessage', payload: {}, requestedAt: 'bad', deadlineAt: '2026-11-07T00:00:30.000Z', traceId: 't' },
    { version: 1, commandId: 'c', idempotencyKey: 'i', accountId: 'a', kind: 'rawSdkMethod', payload: {}, requestedAt: '2026-11-07T00:00:00.000Z', deadlineAt: '2026-11-07T00:00:30.000Z', traceId: 't' },
  ])('rejects an invalid or unknown command envelope', (value) => {
    expect(providerCommandSchema.safeParse(value).success).toBe(false);
  });

  it('keeps unknown provider outcomes explicit and non-retryable by default', () => {
    expect(providerResultSchema.parse({
      version: 1,
      commandId: 'command-1',
      status: 'unknown_outcome',
      retryable: false,
      providerIds: {},
    })).toEqual({
      version: 1,
      commandId: 'command-1',
      status: 'unknown_outcome',
      retryable: false,
      providerIds: {},
    });
  });

  it('requires ordered account identity on provider events', () => {
    expect(providerEventSchema.safeParse({
      version: 1,
      eventId: 'event-1',
      accountId: 'account-1',
      accountSequence: 1,
      kind: 'message',
      occurredAt: '2026-11-07T00:00:00.000Z',
      providerIds: { messageId: 'provider-message-1' },
      payload: {},
    }).success).toBe(true);
    expect(providerEventSchema.safeParse({
      version: 1,
      eventId: 'event-1',
      accountId: 'account-1',
      accountSequence: 0,
      kind: 'message',
      occurredAt: '2026-11-07T00:00:00.000Z',
      payload: {},
    }).success).toBe(false);
  });
});
