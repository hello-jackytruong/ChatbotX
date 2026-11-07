import fs from 'node:fs';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://contract:contract@127.0.0.1:5432/contract_inventory';

const backendRoot = path.resolve(import.meta.dirname, '../..');
const outputPath = path.join(backendRoot, 'contracts/baseline/runtime-socket-contract.json');
const registrations: Array<{ order: number; owner: string; side: 'server' | 'socket'; event: string }> = [];
const rooms: string[] = [];
let order = 0;
let owner = 'socket-auth';

const socket: any = {
  id: 'contract-socket',
  data: { authCtx: { userId: 'synthetic-user', orgId: 'synthetic-org', role: 'admin' } },
  handshake: { auth: {}, headers: {} },
  on(event: string, _handler: unknown) {
    registrations.push({ order: order++, owner, side: 'socket', event });
    return socket;
  },
  join(room: string) { rooms.push(room); return socket; },
  leave: () => socket,
  disconnect: () => socket,
};

const io: any = {
  use(_middleware: unknown) {
    registrations.push({ order: order++, owner, side: 'server', event: '__auth_middleware__' });
    return io;
  },
  on(event: string, handler: (value: typeof socket) => void) {
    registrations.push({ order: order++, owner, side: 'server', event });
    if (event === 'connection') handler(socket);
    return io;
  },
};

const app: any = { jwt: { verify: () => ({ id: 'synthetic-user', orgId: 'synthetic-org', role: 'admin' }) } };
const { registerSocketAuth } = await import('../../src/shared/realtime/socket-auth.js');
const { registerZaloSocketHandlers } = await import('../../src/modules/zalo/zalo-socket.js');
const { registerChatSocketHandlers } = await import('../../src/modules/chat/chat-operations-routes.js');

owner = 'backend/src/shared/realtime/socket-auth.ts';
registerSocketAuth(io, app);
owner = 'backend/src/modules/zalo/zalo-socket.ts';
registerZaloSocketHandlers(io);
owner = 'backend/src/modules/chat/chat-operations-routes.ts';
registerChatSocketHandlers(io);

const contract = {
  version: 1,
  registrations,
  rooms: [...new Set(rooms)].sort(),
};
const content = `${JSON.stringify(contract, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, 'utf8') !== content) {
    console.error('Runtime socket contract drift. Run npm run contracts:generate.');
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(outputPath, content);
}
console.log(`Runtime socket registrations: ${registrations.length}; rooms: ${contract.rooms.length}`);
