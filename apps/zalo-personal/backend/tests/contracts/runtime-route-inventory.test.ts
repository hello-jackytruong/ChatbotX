import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const contractPath = path.resolve(import.meta.dirname, '../../contracts/baseline/runtime-rest-contract.json');

describe('runtime REST contract', () => {
  it('records every Community route by executing its registration plugin', () => {
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    expect(contract.routeCount).toBeGreaterThan(0);
    expect(contract.failures).toEqual([]);
    expect(contract.routes.every((route: { method?: string; path?: string; owner?: string }) =>
      Boolean(route.method && route.path?.startsWith('/') && route.owner))).toBe(true);
  });

  it('contains the health and API status routes registered in app.ts', () => {
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    expect(contract.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', path: '/health' }),
      expect.objectContaining({ method: 'GET', path: '/api/v1/status' }),
    ]));
  });
});
