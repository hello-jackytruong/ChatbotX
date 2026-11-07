import { spawnSync } from "node:child_process"
import path from "node:path"
import process from "node:process"

const repositoryRoot = path.resolve(import.meta.dirname, "../..")
const composeFiles = [
  "-f",
  "docker-compose.dev.yml",
  "-f",
  "docker-compose.zalo-personal.yml",
]

const groups = {
  infra: [
    "postgres",
    "redis",
    "filesystem",
    "filesystem-init",
    "mailhog",
    "adminer",
    "redis-ui",
  ],
  chatbotx: [
    "postgres",
    "redis",
    "filesystem",
    "filesystem-init",
    "mailhog",
    "adminer",
    "redis-ui",
    "javascript-executor",
    "builder",
    "realtime",
    "gateway",
    "worker",
  ],
  zalo: ["postgres", "redis", "filesystem", "zalo-personal"],
}
groups.full = [
  ...new Set([...groups.infra, ...groups.chatbotx, ...groups.zalo]),
]

function compose(args) {
  const result = spawnSync("docker", ["compose", ...composeFiles, ...args], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function resolveGroup(name = "full") {
  const services = groups[name]
  if (!services) {
    console.error(
      `Unknown group "${name}". Expected one of: ${Object.keys(groups).join(", ")}`,
    )
    process.exit(2)
  }
  return services
}

function prepareChatbotX() {
  compose(["up", "-d", "--wait", "--wait-timeout", "120", "postgres"])
  compose(["build", "builder"])
  compose([
    "run",
    "--rm",
    "--no-deps",
    "builder",
    "sh",
    "-lc",
    [
      "node packages/database/scripts/run-migrations.mjs",
      "pnpm --dir packages/database exec tsx scripts/migrate-shards.ts",
      "pnpm --dir packages/database exec tsx src/seed/index.ts",
    ].join(" && "),
  ])
}

function prepareZalo() {
  compose([
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "120",
    "postgres",
    "redis",
    "filesystem",
  ])
  compose([
    "--profile",
    "prepare",
    "run",
    "--rm",
    "--no-deps",
    "zalo-database-init",
  ])
  compose([
    "--profile",
    "prepare",
    "run",
    "--rm",
    "--no-deps",
    "zalo-filesystem-init",
  ])
  compose(["build", "zalo-personal"])
  compose([
    "run",
    "--rm",
    "--no-deps",
    "zalo-personal",
    "npx",
    "prisma",
    "migrate",
    "deploy",
  ])
}

function printUsage() {
  console.log(`Usage:
  pnpm docker:dev up <infra|chatbotx|zalo|full>
  pnpm docker:dev prepare <chatbotx|zalo|full>
  pnpm docker:dev stop <infra|chatbotx|zalo|full>
  pnpm docker:dev restart <infra|chatbotx|zalo|full>
  pnpm docker:dev status [infra|chatbotx|zalo|full]
  pnpm docker:dev logs [infra|chatbotx|zalo|full|service]
  pnpm docker:dev down
  pnpm docker:dev config

The prepare command is the only development command that changes database
schemas or seed data. Down never removes named volumes.`)
}

const [command, target = "full"] = process.argv.slice(2)

switch (command) {
  case "up": {
    const services = resolveGroup(target)
    const build = target === "infra" ? [] : ["--build"]
    compose(["up", "-d", ...build, ...services])
    compose(["ps", "-a", ...services])
    break
  }
  case "prepare":
    if (target === "chatbotx" || target === "full") {
      prepareChatbotX()
    }
    if (target === "zalo" || target === "full") {
      prepareZalo()
    }
    if (!new Set(["chatbotx", "zalo", "full"]).has(target)) {
      console.error('Prepare target must be "chatbotx", "zalo", or "full".')
      process.exit(2)
    }
    break
  case "stop":
    compose(["stop", ...resolveGroup(target)])
    break
  case "restart":
    compose(["restart", ...resolveGroup(target)])
    break
  case "status":
    compose(["ps", "-a", ...resolveGroup(target)])
    break
  case "logs": {
    const services = groups[target] ?? [target]
    compose(["logs", "--tail=200", ...services])
    break
  }
  case "down":
    compose(["down", "--remove-orphans"])
    break
  case "config":
    compose(["config", "--quiet"])
    break
  case "help":
  case "--help":
  case "-h":
  case undefined:
    printUsage()
    break
  default:
    console.error(`Unknown command "${command}".`)
    printUsage()
    process.exit(2)
}
