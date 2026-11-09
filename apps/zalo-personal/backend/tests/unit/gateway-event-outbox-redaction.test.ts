import { describe, expect, it, vi } from 'vitest';
import { PrismaGatewayEventOutbox } from '../../src/modules/gateway/event-outbox.js';

describe('PrismaGatewayEventOutbox QR retention', () => {
  it('redacts expired QR images without deleting or renumbering events', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      { event_id: 'event-1' },
      { event_id: 'event-2' },
    ]);
    const outbox = new PrismaGatewayEventOutbox({
      $queryRaw: queryRaw,
      $transaction: vi.fn(),
    } as never);
    const before = new Date('2026-11-09T00:05:00.000Z');

    await expect(outbox.redactExpiredQrImages(before)).resolves.toBe(2);

    const query = queryRaw.mock.calls[0]?.[0] as {
      strings: readonly string[];
      values: readonly unknown[];
    };
    const sql = query.strings.join('?');
    expect(sql).toContain("- 'qrImage'");
    expect(sql).toContain('{"redacted":true}');
    expect(sql).toContain('LIMIT 500');
    expect(sql).toContain('RETURNING "events"."event_id"');
    expect(query.values).toContain(before);
  });
});
