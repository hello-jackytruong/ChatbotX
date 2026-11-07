import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://contract:contract@127.0.0.1:5432/socket_contract';

vi.mock('../../../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let registerSocketAuth: typeof import('../../../src/shared/realtime/socket-auth.js').registerSocketAuth;
let registerZaloSocketHandlers: typeof import('../../../src/modules/zalo/zalo-socket.js').registerZaloSocketHandlers;
let client: ClientSocket | null = null;
let io: Server | null = null;

beforeAll(async () => {
  ({ registerSocketAuth } = await import('../../../src/shared/realtime/socket-auth.js'));
  ({ registerZaloSocketHandlers } = await import('../../../src/modules/zalo/zalo-socket.js'));
});

afterEach(async () => {
  client?.disconnect();
  client = null;
  if (io) await new Promise<void>((resolve) => io!.close(() => resolve()));
  io = null;
});

describe('Socket.IO wire contract', () => {
  it('authenticates over a real Socket.IO connection and only joins token-derived rooms', async () => {
    const httpServer = createServer();
    io = new Server(httpServer, { transports: ['websocket'] });
    const app = {
      jwt: {
        verify: vi.fn(() => ({
          id: 'synthetic-user',
          orgId: 'synthetic-org',
          role: 'admin',
          typ: 'access',
        })),
      },
    } as any;

    registerSocketAuth(io, app);
    registerZaloSocketHandlers(io);

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;
    client = createClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      auth: { token: 'synthetic-access-token' },
    });

    await new Promise<void>((resolve, reject) => {
      client!.once('connect', () => resolve());
      client!.once('connect_error', reject);
    });

    const [serverSocket] = await io.fetchSockets();
    expect(serverSocket.rooms.has('org:synthetic-org')).toBe(true);
    expect(serverSocket.rooms.has('user:synthetic-user')).toBe(true);

    client.emit('org:join', { orgId: 'foreign-org' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [afterDeprecatedJoin] = await io.fetchSockets();
    expect(afterDeprecatedJoin.rooms.has('org:foreign-org')).toBe(false);
  });

  it('rejects a real connection without a token', async () => {
    const httpServer = createServer();
    io = new Server(httpServer, { transports: ['websocket'] });
    registerSocketAuth(io, { jwt: { verify: vi.fn() } } as any);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;
    client = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });

    const error = await new Promise<Error>((resolve) => client!.once('connect_error', resolve));
    expect(error.message).toBe('unauthorized');
    expect(client.connected).toBe(false);
  });
});
