import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"

const repositoryRoot = path.resolve(import.meta.dirname, "../..")
const npmRunner = path.join(import.meta.dirname, "run-npm.mjs")
const defaultDatabaseUrl = new URL("postgresql://localhost:5432/zalo_personal")
defaultDatabaseUrl.username = process.env.ZALO_DB_USER ?? "zalo_personal"
defaultDatabaseUrl.password =
  process.env.ZALO_DB_PASSWORD ?? "zalo-personal-dev-password"
const requiredExecutables = [
  "apps/zalo-personal/backend/node_modules/.bin/tsx",
  "apps/zalo-personal/frontend/node_modules/.bin/vite",
]
if (
  requiredExecutables.some(
    (relative) => !fs.existsSync(path.join(repositoryRoot, relative)),
  )
) {
  console.error(
    "Zalo Personal dependencies are missing. Run `pnpm zalo-personal:install` first.",
  )
  process.exit(1)
}

const infrastructure = spawnSync(
  process.execPath,
  [path.join(import.meta.dirname, "compose.mjs"), "dev-up"],
  {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  },
)
if (infrastructure.status !== 0) {
  process.exit(infrastructure.status ?? 1)
}

const backendEnvironment = {
  ...process.env,
  NODE_ENV: "development",
  PORT: process.env.ZALO_DEV_BACKEND_PORT ?? "3000",
  APP_URL: process.env.ZALO_DEV_APP_URL ?? "http://localhost:5173",
  DATABASE_URL: process.env.ZALO_DATABASE_URL ?? defaultDatabaseUrl.href,
  REDIS_URL: process.env.ZALO_REDIS_URL ?? "redis://localhost:6379/1",
  STORAGE_DRIVER: process.env.ZALO_STORAGE_DRIVER ?? "r2",
  S3_ENDPOINT: process.env.ZALO_S3_ENDPOINT ?? "http://localhost:9000",
  S3_PUBLIC_URL:
    process.env.ZALO_S3_PUBLIC_URL ??
    "http://localhost:9000/zalocrm-attachments",
  S3_BUCKET: process.env.ZALO_S3_BUCKET ?? "zalocrm-attachments",
  S3_REGION: process.env.ZALO_S3_REGION ?? "us-east-1",
  S3_ACCESS_KEY: process.env.ZALO_S3_ACCESS_KEY_ID ?? "zalo-personal-dev",
  S3_SECRET_KEY:
    process.env.ZALO_S3_SECRET_ACCESS_KEY ?? "zalo-personal-dev-secret",
  CLAMAV_HOST: process.env.ZALO_CLAMAV_HOST ?? "localhost",
  CLAMAV_PORT: process.env.ZALO_CLAMAV_PORT ?? "3310",
}

const children = [
  spawn(
    process.execPath,
    [npmRunner, "--prefix", "apps/zalo-personal/backend", "run", "dev"],
    {
      cwd: repositoryRoot,
      env: backendEnvironment,
      stdio: "inherit",
    },
  ),
  spawn(
    process.execPath,
    [npmRunner, "--prefix", "apps/zalo-personal/frontend", "run", "dev"],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    },
  ),
]

let stopping = false
function stop(exitCode = 0) {
  if (stopping) {
    return
  }
  stopping = true
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM")
    }
  }
  setTimeout(() => process.exit(exitCode), 250)
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(0))
}
for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!stopping) {
      stop(signal ? 1 : (code ?? 1))
    }
  })
  child.on("error", () => stop(1))
}
