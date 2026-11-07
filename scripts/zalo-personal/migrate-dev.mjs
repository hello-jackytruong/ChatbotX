import { spawnSync } from "node:child_process"
import path from "node:path"
import process from "node:process"

const repositoryRoot = path.resolve(import.meta.dirname, "../..")
const defaultDatabaseUrl = new URL("postgresql://localhost:5432/zalo_personal")
defaultDatabaseUrl.username = process.env.ZALO_DB_USER ?? "zalo_personal"
defaultDatabaseUrl.password =
  process.env.ZALO_DB_PASSWORD ?? "zalo-personal-dev-password"
const environment = {
  ...process.env,
  DATABASE_URL: process.env.ZALO_DATABASE_URL ?? defaultDatabaseUrl.href,
}

function runScript(script, args) {
  const result = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, script), ...args],
    {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit",
    },
  )
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

runScript("compose.mjs", ["dev-up"])
runScript("compose.mjs", ["dev-prepare"])
runScript("compose.mjs", ["dev-prepare-filesystem"])
runScript("run-npm.mjs", [
  "--prefix",
  "apps/zalo-personal/backend",
  "exec",
  "--",
  "prisma",
  "migrate",
  "deploy",
])
