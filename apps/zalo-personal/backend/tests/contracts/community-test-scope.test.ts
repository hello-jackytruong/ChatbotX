import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const backendRoot = path.resolve(import.meta.dirname, '../..');
const testsRoot = path.join(backendRoot, 'tests');
const manifestPath = path.join(testsRoot, 'extension-test-files.json');
const databaseManifestPath = path.join(testsRoot, 'database-test-files.json');

function listTestFiles(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      const absolutePath = path.join(directory, entry);
      if (statSync(absolutePath).isDirectory()) {
        return listTestFiles(absolutePath);
      }
      return absolutePath.endsWith('.test.ts') ? [absolutePath] : [];
    })
    .sort();
}

function findUnavailableExtensionImports(): string[] {
  const unavailableImport =
    /src\/(?:_ee|modules\/(?:automation|lead-pool|integrations\/(?:facebook-leadads|providers\/facebook)))\//;
  return listTestFiles(testsRoot)
    .filter((file) => unavailableImport.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(backendRoot, file))
    .sort();
}

function findDatabaseIntegrationTests(): string[] {
  return listTestFiles(testsRoot)
    .filter((file) => {
      const source = readFileSync(file, 'utf8');
      const importsPrisma =
        /import\s+\{\s*prisma\s*\}\s+from\s+['"][^'"]*prisma-client/.test(
          source,
        );
      const mocksPrisma =
        /vi\.mock\(\s*['"][^'"]*prisma-client/.test(source);
      return importsPrisma && !mocksPrisma;
    })
    .map((file) => path.relative(backendRoot, file))
    .sort();
}

describe('Community test scope', () => {
  it('classifies every test that imports unavailable extension source', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      excludedTests: string[];
    };

    expect([...manifest.excludedTests].sort()).toEqual(
      findUnavailableExtensionImports(),
    );
  });

  it('does not classify tests whose source is available in Community', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      excludedTests: string[];
    };

    for (const testFile of manifest.excludedTests) {
      const source = readFileSync(path.join(backendRoot, testFile), 'utf8');
      expect(source).toMatch(
        /src\/(?:_ee|modules\/(?:automation|lead-pool|integrations\/(?:facebook-leadads|providers\/facebook)))\//,
      );
    }
  });

  it('classifies every test that requires a real PostgreSQL database', () => {
    const manifest = JSON.parse(
      readFileSync(databaseManifestPath, 'utf8'),
    ) as { databaseTests: string[] };

    expect([...manifest.databaseTests].sort()).toEqual(
      findDatabaseIntegrationTests(),
    );
  });
});
