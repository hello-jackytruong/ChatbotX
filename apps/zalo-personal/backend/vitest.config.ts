import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const extensionTestManifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./tests/extension-test-files.json', import.meta.url)),
    'utf8',
  ),
) as { excludedTests: string[] };
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
    include: ['tests/**/*.test.ts'],
    exclude: [
      ...extensionTestManifest.excludedTests,
      ...databaseTestManifest.databaseTests,
    ],
    // 2026-06-11 — DATABASE_URL giả để test UNIT (hàm thuần) import được prisma-client
    // mà không cần DB thật (prisma init lazy, không connect). Test cần DB thật override
    // qua env runtime. Đảm bảo privacy-redact-regression chạy ở mọi máy/CI.
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test',
    },
    coverage: {
      provider: 'v8',
      include: ['src/modules/**/*.ts', 'src/shared/**/*.ts'],
    },
  },
});
