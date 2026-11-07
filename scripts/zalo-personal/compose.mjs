import { spawnSync } from "node:child_process"
import path from "node:path"
import process from "node:process"

const repositoryRoot = path.resolve(import.meta.dirname, "../..")
const action = process.argv[2]
const devFiles = [
  "-f",
  "docker-compose.yml",
  "-f",
  "docker-compose.zalo-personal.yml",
]
const productionFiles = [
  "-f",
  "docker-compose.production.yml",
  "-f",
  "docker-compose.zalo-personal.production.yml",
]

const actions = {
  "dev-up": [
    ...devFiles,
    "up",
    "-d",
    "postgres",
    "redis",
    "filesystem",
    "filesystem-init",
    "adminer",
    "redis-ui",
  ],
  "dev-prepare": [
    ...devFiles,
    "--profile",
    "prepare",
    "run",
    "--rm",
    "--no-deps",
    "zalo-database-init",
  ],
  "dev-prepare-filesystem": [
    ...devFiles,
    "--profile",
    "prepare",
    "run",
    "--rm",
    "--no-deps",
    "zalo-filesystem-init",
  ],
  "dev-down": [...devFiles, "stop", "zalo-personal"],
  "prod-config": [...productionFiles, "config", "--quiet"],
}

const args = actions[action]
if (!args) {
  console.error(
    `Unknown action "${action ?? ""}". Expected: ${Object.keys(actions).join(", ")}`,
  )
  process.exit(2)
}

const result = spawnSync("docker", ["compose", ...args], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit",
})
process.exit(result.status ?? 1)
