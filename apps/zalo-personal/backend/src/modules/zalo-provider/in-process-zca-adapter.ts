import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { imageSize } from 'image-size';

export type ZcaSession = {
  login: (...args: unknown[]) => Promise<unknown>;
  loginQR: (...args: unknown[]) => Promise<unknown>;
};

type ZcaOptions = {
  logging: boolean;
  selfListen: boolean;
  imageMetadataGetter: (path: string) => Promise<{
    width: number;
    height: number;
    size: number;
  }>;
};

export type ZcaSessionFactory = (options: ZcaOptions) => ZcaSession;

async function imageMetadataGetter(filePath: string) {
  const data = await readFile(filePath);
  const info = imageSize(data);
  if (!info.width || !info.height) {
    throw new Error(`Cannot read image size: ${filePath}`);
  }
  return { width: info.width, height: info.height, size: data.length };
}

const require = createRequire(import.meta.url);
const { Zalo } = require('zca-js') as {
  Zalo: new (options: ZcaOptions) => ZcaSession;
};

const defaultFactory: ZcaSessionFactory = (options) => new Zalo(options);

export class InProcessZcaAdapter {
  constructor(private readonly factory: ZcaSessionFactory = defaultFactory) {}

  createSession(): ZcaSession {
    return this.factory({
      logging: false,
      selfListen: true,
      imageMetadataGetter,
    });
  }
}

export const inProcessZcaAdapter = new InProcessZcaAdapter();
