import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../contracts/baseline');

function read(name: string) {
  return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
}

describe('Community contract manifests', () => {
  it('retains all opening Prisma models while allowing additive gateway models', () => {
    const contract = read('database-contract.json');
    expect(contract.modelCount).toBeGreaterThanOrEqual(108);
    expect(contract.models).toHaveLength(contract.modelCount);
    expect(new Set(contract.models.map((model: { name: string }) => model.name)).size).toBe(contract.modelCount);
    expect(contract.models.every((model: { fields: unknown[] }) => model.fields.length > 0)).toBe(true);
  });

  it('classifies every discovered API, socket use, object and function', () => {
    const rest = read('rest-contract.json');
    const socket = read('socket-contract.json');
    const object = read('object-contract.json');
    const functions = read('function-test-map.json');
    expect(rest.routeCount).toBeGreaterThan(0);
    expect(socket.eventUseCount).toBeGreaterThan(0);
    expect(object.objectCount).toBeGreaterThan(0);
    expect(functions.functionCount).toBeGreaterThan(0);
    expect(functions.functions.every((entry: { risk?: string; status?: string; file?: string }) =>
      ['P0', 'P1', 'P2'].includes(entry.risk ?? '')
      && ['UNTESTED', 'PARTIAL', 'FULL'].includes(entry.status ?? '')
      && Boolean(entry.file))).toBe(true);
  });

  it('never falls below the approved Zalo Personal opening counts', () => {
    const fixture = JSON.parse(fs.readFileSync(
      path.resolve(import.meta.dirname, 'fixtures/zalo-personal-public-v1.json'),
      'utf8',
    ));
    const database = read('database-contract.json');
    const rest = read('rest-contract.json');
    const runtimeRest = read('runtime-rest-contract.json');
    const socket = read('socket-contract.json');
    const runtimeSocket = read('runtime-socket-contract.json');
    const object = read('object-contract.json');
    const functions = read('function-test-map.json');

    expect(rest.routeCount).toBeGreaterThanOrEqual(fixture.baselineCounts.routes);
    expect(runtimeRest.routeCount).toBeGreaterThanOrEqual(fixture.baselineCounts.runtimeRoutes);
    expect(runtimeRest.failures.length).toBe(fixture.baselineCounts.runtimeRouteFailures);
    expect(runtimeSocket.registrations.length).toBeGreaterThanOrEqual(
      fixture.baselineCounts.runtimeSocketRegistrations,
    );
    expect(runtimeSocket.rooms.length).toBeGreaterThanOrEqual(
      fixture.baselineCounts.runtimeSocketRooms,
    );
    expect(socket.eventUseCount).toBeGreaterThanOrEqual(fixture.baselineCounts.socketUses);
    expect(database.modelCount).toBeGreaterThanOrEqual(fixture.baselineCounts.models);
    expect(object.objectCount).toBeGreaterThanOrEqual(fixture.baselineCounts.objects);
    expect(functions.functionCount).toBeGreaterThanOrEqual(fixture.baselineCounts.functions);
  });

  it('contains only deterministic sanitized fixtures', () => {
    const fixtureRoot = path.resolve(import.meta.dirname, '../fixtures/sanitized');
    const text = fs.readdirSync(fixtureRoot)
      .filter((name) => name.endsWith('.json'))
      .map((name) => fs.readFileSync(path.join(fixtureRoot, name), 'utf8'))
      .join('\n');
    expect(text).not.toMatch(/(?:access|refresh|session|private)[_-]?token/i);
    expect(text).not.toMatch(/(?:cookie|imei|qrData|secretKey|password)\s*["']?\s*:/i);
    expect(text).not.toMatch(/\b(?:\+?84|0)\d{8,10}\b/);
    expect(text).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  });

  it('keeps the Zalo Personal behavioral goldens free of credentials and customer data', () => {
    const fixtureRoot = path.resolve(import.meta.dirname, 'fixtures');
    const text = fs.readdirSync(fixtureRoot)
      .filter((name) => name.startsWith('zalo-personal-') && name.endsWith('.json'))
      .map((name) => fs.readFileSync(path.join(fixtureRoot, name), 'utf8'))
      .join('\n');
    expect(text).not.toMatch(/(?:cookie|imei|userAgent|proxyUrl|authorization|secret|password)\s*"?\s*:/i);
    expect(text).not.toMatch(/\b(?:\+?84|0)\d{8,10}\b/);
    expect(text).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  });
});
