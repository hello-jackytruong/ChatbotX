import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareGatewayOperation } from '../../src/modules/zalo-provider/gateway-operation-payload.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('gateway operation payload', () => {
  it('removes Socket.IO instances while preserving positional arguments', async () => {
    const io: any = { emit() {} };
    io.self = io;
    const prepared = await prepareGatewayOperation(
      'sendMessage',
      ['thread-1', 0, { msg: 'synthetic' }, io],
      'command-1',
    );

    expect(prepared.args).toEqual(['thread-1', 0, { msg: 'synthetic' }, null]);
    expect(() => JSON.stringify(prepared.args)).not.toThrow();
    expect(prepared.stagedDirectory).toBeNull();
  });

  it('copies local media into the shared gateway spool without changing content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zalo-gateway-payload-'));
    tempRoots.push(root);
    const source = join(root, 'source.jpg');
    await writeFile(source, 'synthetic-media');

    const prepared = await prepareGatewayOperation(
      'sendImage',
      ['thread-1', 0, [source], null, 'caption'],
      'command-2',
      join(root, 'spool'),
    );

    const staged = (prepared.args[2] as string[])[0];
    expect(staged).not.toBe(source);
    expect(staged.startsWith(join(root, 'spool', 'command-2'))).toBe(true);
    await expect(readFile(staged, 'utf8')).resolves.toBe('synthetic-media');
    expect(prepared.stagedDirectory).toBe(join(root, 'spool', 'command-2'));
  });
});
