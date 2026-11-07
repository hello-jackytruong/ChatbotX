import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is required and must point to an isolated PostgreSQL test database',
  );
}

const databaseTestManifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./tests/database-test-files.json', import.meta.url)),
    'utf8',
  ),
) as { databaseTests: string[] };

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: databaseTestManifest.databaseTests,
    env: {
      DATABASE_URL: databaseUrl,
    },
    coverage: {
      provider: 'v8',
      include: ['src/modules/**/*.ts', 'src/shared/**/*.ts'],
    },
  },
});
