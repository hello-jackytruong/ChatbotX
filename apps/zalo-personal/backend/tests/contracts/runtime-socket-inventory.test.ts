import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const contract = JSON.parse(fs.readFileSync(
  path.resolve(import.meta.dirname, '../../contracts/baseline/runtime-socket-contract.json'),
  'utf8',
));

describe('runtime Socket.IO contract', () => {
  it('registers authentication before connection handlers', () => {
    expect(contract.registrations[0]).toMatchObject({
      owner: 'backend/src/shared/realtime/socket-auth.ts',
      side: 'server',
      event: '__auth_middleware__',
    });
  });

  it('locks client event names and token-derived rooms', () => {
    const events = contract.registrations.map((entry: { event: string }) => entry.event);
    expect(events).toEqual(expect.arrayContaining([
      'org:join',
      'zalo:subscribe',
      'zalo:unsubscribe',
      'chat:typing',
      'disconnect',
    ]));
    expect(contract.rooms).toEqual(['org:synthetic-org', 'user:synthetic-user']);
  });
});
