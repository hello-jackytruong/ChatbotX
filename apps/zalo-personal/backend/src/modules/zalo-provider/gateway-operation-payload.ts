import { copyFile, lstat, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { ProviderOperationName } from './contracts.js';

const DEFAULT_SPOOL_ROOT = '/var/lib/zalo-crm/files/gateway-spool';
const socketArgumentOperations = new Set<ProviderOperationName>([
  'sendFile',
  'sendImage',
  'sendMessage',
  'sendVideo',
]);

function safeFilename(path: string, index: number): string {
  const cleaned = basename(path).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180) || 'attachment';
  return `${String(index).padStart(3, '0')}-${cleaned}`;
}

async function stagePath(
  source: unknown,
  directory: string,
  copied: Map<string, string>,
): Promise<unknown> {
  if (typeof source !== 'string' || source.length === 0) return source;
  if (/^https?:\/\//i.test(source)) return source;
  const absolute = resolve(source);
  if (absolute.startsWith(`${resolve(directory)}/`)) return absolute;
  const existing = copied.get(absolute);
  if (existing) return existing;
  const stat = await lstat(absolute);
  if (!stat.isFile()) throw new Error('Gateway media source must be a regular file');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, safeFilename(absolute, copied.size));
  await copyFile(absolute, destination);
  copied.set(absolute, destination);
  return destination;
}

async function stageObjectPaths(
  value: unknown,
  directory: string,
  copied: Map<string, string>,
): Promise<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const clone = { ...(value as Record<string, unknown>) };
  for (const key of ['filePath', 'path', 'thumbnailPath', 'videoPath']) {
    if (key in clone) clone[key] = await stagePath(clone[key], directory, copied);
  }
  if (Array.isArray(clone.attachments)) {
    clone.attachments = await Promise.all(clone.attachments.map((entry) =>
      typeof entry === 'string'
        ? stagePath(entry, directory, copied)
        : stageObjectPaths(entry, directory, copied)));
  }
  return clone;
}

export type PreparedGatewayOperation = {
  args: unknown[];
  stagedDirectory: string | null;
};

export async function prepareGatewayOperation(
  kind: ProviderOperationName,
  inputArgs: unknown[],
  commandId: string,
  spoolRoot = process.env.ZALO_GATEWAY_SPOOL_DIR || DEFAULT_SPOOL_ROOT,
): Promise<PreparedGatewayOperation> {
  const args = [...inputArgs];
  if (socketArgumentOperations.has(kind) && args.length > 3) args[3] = null;

  const directory = join(spoolRoot, commandId);
  const copied = new Map<string, string>();
  if (kind === 'sendImage' || kind === 'sendFile') {
    if (Array.isArray(args[2])) {
      args[2] = await Promise.all(args[2].map((entry) =>
        typeof entry === 'string'
          ? stagePath(entry, directory, copied)
          : stageObjectPaths(entry, directory, copied)));
    }
  } else if (kind === 'uploadAttachment') {
    const pathsIndex = Array.isArray(args[0]) ? 0 : 2;
    if (Array.isArray(args[pathsIndex])) {
      args[pathsIndex] = await Promise.all(
        (args[pathsIndex] as unknown[]).map((entry) => stagePath(entry, directory, copied)),
      );
    }
  } else if (kind === 'sendVoice') {
    args[2] = await stagePath(args[2], directory, copied);
  } else if (kind === 'changeGroupAvatar' || kind === 'changeAccountAvatar') {
    args[0] = await stagePath(args[0], directory, copied);
  } else if (kind === 'sendVideo') {
    args[2] = await stageObjectPaths(args[2], directory, copied);
  } else if (kind === 'sendNativeVideo') {
    args[0] = await stageObjectPaths(args[0], directory, copied);
  }

  return { args, stagedDirectory: copied.size > 0 ? directory : null };
}
