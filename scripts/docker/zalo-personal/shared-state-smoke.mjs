import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const repositoryRoot = path.resolve(import.meta.dirname, "../../..")
const USED_MEMORY_PATTERN = /^used_memory:(\d+)/m
const EVICTED_KEYS_PATTERN = /^evicted_keys:(\d+)/m
const mode = process.argv[2]
if (!new Set(["--before", "--after"]).has(mode)) {
  throw new Error("Usage: shared-state-smoke.mjs --before|--after")
}

const stateDirectory =
  process.env.ZALO_STATE_DIR ?? "/var/lib/chatbotx-production/zalo-personal"
const statePath = path.join(stateDirectory, "shared-state-smoke.json")
const composeArgs = [
  "compose",
  "--project-directory",
  repositoryRoot,
  "-f",
  path.join(repositoryRoot, "docker-compose.production.yml"),
  "-f",
  path.join(repositoryRoot, "docker-compose.zalo-personal.production.yml"),
]

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim()
}

function compose(args, options) {
  return docker([...composeArgs, ...args], options)
}

function fingerprint(service) {
  const id = compose(["ps", "-q", service])
  if (!id) {
    throw new Error(`Required service is not running: ${service}`)
  }
  const value = docker([
    "inspect",
    "--format",
    "{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Health.Status}}|{{.HostConfig.Memory}}",
    id,
  ])
  const [containerId, startedAt, restartCount, health, memoryLimit] =
    value.split("|")
  if (health !== "healthy") {
    throw new Error(`${service} is not healthy`)
  }
  return {
    containerId,
    memoryLimit: Number(memoryLimit),
    restartCount: Number(restartCount),
    startedAt,
  }
}

function verifyTopology() {
  const config = JSON.parse(
    compose(["--profile", "bootstrap", "config", "--format", "json"]),
  )
  for (const forbidden of ["zalo-postgres", "zalo-redis", "zalo-backup"]) {
    if (config.services[forbidden]) {
      throw new Error(`Duplicate stateful service exists: ${forbidden}`)
    }
  }
}

function postgresCapacity() {
  const output = compose([
    "exec",
    "-T",
    "postgres",
    "sh",
    "-ec",
    'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) || \'|\' || current_setting(\'max_connections\') FROM pg_stat_activity"',
  ])
  const [used, maximum] = output.split("|").map(Number)
  if (!(maximum > 0) || used / maximum >= 0.8) {
    throw new Error(
      `PostgreSQL connection headroom is below 20% (${used}/${maximum})`,
    )
  }
  return { maximum, used }
}

function redisCapacity(memoryLimit) {
  const info = compose(["exec", "-T", "redis", "redis-cli", "INFO", "memory"])
  const used = Number(info.match(USED_MEMORY_PATTERN)?.[1])
  if (!(used >= 0 && memoryLimit > 0)) {
    throw new Error(
      "Redis memory usage or container memory limit is unavailable",
    )
  }
  if (used / memoryLimit >= 0.8) {
    throw new Error("Redis memory headroom is below 20%")
  }
  const evicted = Number(
    compose(["exec", "-T", "redis", "redis-cli", "INFO", "stats"]).match(
      EVICTED_KEYS_PATTERN,
    )?.[1],
  )
  if (evicted !== 0) {
    throw new Error(`Redis reports ${evicted} evicted keys`)
  }
  return { evicted, memoryLimit, used }
}

function setSentinels(token) {
  compose([
    "exec",
    "-T",
    "redis",
    "redis-cli",
    "-n",
    "0",
    "SET",
    `chatbotx:shared-state-smoke:${token}`,
    token,
  ])
  compose([
    "exec",
    "-T",
    "redis",
    "redis-cli",
    "-n",
    "1",
    "SET",
    `zalo:shared-state-smoke:${token}`,
    token,
  ])
}

function verifySentinels(token) {
  for (const [database, prefix] of [
    [0, "chatbotx"],
    [1, "zalo"],
  ]) {
    const value = compose([
      "exec",
      "-T",
      "redis",
      "redis-cli",
      "-n",
      String(database),
      "GET",
      `${prefix}:shared-state-smoke:${token}`,
    ])
    if (value !== token) {
      throw new Error(`Redis DB ${database} sentinel changed or disappeared`)
    }
  }
}

verifyTopology()
const shared = Object.fromEntries(
  ["postgres", "redis", "filesystem"].map((service) => [
    service,
    fingerprint(service),
  ]),
)
const capacity = {
  postgres: postgresCapacity(),
  redis: redisCapacity(shared.redis.memoryLimit),
}

if (mode === "--before") {
  const token = `${Date.now()}-${process.pid}`
  setSentinels(token)
  mkdirSync(stateDirectory, { mode: 0o700, recursive: true })
  writeFileSync(
    statePath,
    `${JSON.stringify({ capacity, shared, token }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  )
  console.log(
    "Recorded shared container identities, capacity, and Redis DB0/DB1 sentinels.",
  )
} else {
  const before = JSON.parse(readFileSync(statePath, "utf8"))
  if (JSON.stringify(shared) !== JSON.stringify(before.shared)) {
    throw new Error(
      "Shared container identity, start time, or restart count changed",
    )
  }
  verifySentinels(before.token)
  compose([
    "exec",
    "-T",
    "zalo-personal",
    "node",
    "-e",
    "fetch('http://127.0.0.1:3000/api/v1/setup/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
  ])
  console.log("Shared state and Zalo health remained stable after deployment.")
}
