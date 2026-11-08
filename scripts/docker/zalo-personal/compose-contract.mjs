import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const repositoryRoot = path.resolve(import.meta.dirname, "../../..")
const PG18_PATTERN = /pg18/
const APPEND_ONLY_PATTERN = /appendonly yes/
const APPEND_FSYNC_PATTERN = /appendfsync everysec/
const NO_EVICTION_PATTERN = /maxmemory-policy noeviction/
const CHATBOTX_DATABASE_PATTERN = /@postgres:5432\/chatbotx/
const ZALO_DATA_SERVICE_PATTERN = /"zalo-postgres"|"zalo-redis"/
const DEV_DOWN_ACTION_PATTERN = /"dev-down": \[[\s\S]*?\],/
const SHARED_STOP_PATTERN = /"postgres"|"redis"|"filesystem"/
const WORKFLOW_CONTEXT_PATTERN = /context: \$\{\{ matrix\.context \}\}/
const WORKFLOW_ACTIVATION_ENVIRONMENT_PATTERN = /environment: production/
const WORKFLOW_BASELINE_ENVIRONMENT_PATTERN =
  /environment: \$\{\{ matrix\.environment \}\}/
const DEV_OPTIONAL_ENV_FILE_PATTERN =
  /env_file:\s*\n\s*- path: \.\/\.env\s*\n\s*required: false/
const WORKFLOW_DISPATCH_PATTERN = /production-full\.sh pull-deploy/
const WORKFLOW_BOOTSTRAP_LOCK_PATTERN =
  /exec 9>.*chatbotx-production\.lock[\s\S]*flock -n 9[\s\S]*git fetch[\s\S]*git checkout/
const DEV_FILESYSTEM_PREPARE_PATTERN =
  /"dev-prepare-filesystem": \[[\s\S]*?"zalo-filesystem-init"[\s\S]*?\],/
const MIGRATION_FILESYSTEM_PREPARE_PATTERN = /"dev-prepare-filesystem"/
const FORBIDDEN_PRODUCTION_PATTERNS = [
  /FLUSHALL/i,
  /FLUSHDB/i,
  /SWAPDB/i,
  /down\s+--volumes/i,
  /volume\s+rm/i,
  /compose\s+up[^\n]*(?:postgres|redis|filesystem)/i,
  /compose\s+restart[^\n]*(?:postgres|redis|filesystem)/i,
]
const fixtureEnvironment = {
  ...process.env,
  CHATBOTX_ENV_FILE: ".env.example",
  APP_URL: "https://chatbotx.example.test",
  POSTGRES_PASSWORD: "chatbotx-postgres-password",
  S3_ACCESS_KEY_ID: "chatbotx-storage-root",
  S3_SECRET_ACCESS_KEY: "chatbotx-storage-root-secret",
  REALTIME_BROADCAST_SECRET: "realtime-secret-at-least-32-characters",
  JAVASCRIPT_EXECUTOR_TOKEN: "executor-secret-at-least-32-characters",
  ZALO_APP_URL: "https://zalo.example.test",
  ZALO_DATABASE_URL:
    "postgresql://zalo_personal:zalo-postgres-password@postgres:5432/zalo_personal",
  ZALO_DB_PASSWORD: "zalo-postgres-password",
  ZALO_JWT_SECRET: "zalo-jwt-secret-at-least-32-characters",
  ZALO_ENCRYPTION_KEY: "a".repeat(64),
  ZALO_GATEWAY_CREDENTIAL_KEY: "b".repeat(64),
  ZALO_BRIDGE_SECRET_KEY: "c".repeat(64),
  ZALO_REDIS_URL: "redis://redis:6379/1",
  ZALO_S3_ACCESS_KEY_ID: "zalo-storage-user",
  ZALO_S3_SECRET_ACCESS_KEY: "zalo-storage-user-secret",
  ZALO_S3_PUBLIC_URL: "https://files.example.test/zalocrm-attachments",
}

function composeConfig(files, profile) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      ...files.flatMap((file) => ["-f", file]),
      "--profile",
      profile,
      "config",
      "--format",
      "json",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: fixtureEnvironment,
    },
  )
  if (result.status !== 0) {
    throw new Error(
      `docker compose config failed:\n${result.stderr || result.stdout}`,
    )
  }
  return JSON.parse(result.stdout)
}

const commandText = (service) =>
  Array.isArray(service.command) ? service.command.join(" ") : service.command
const publishedPorts = (service) =>
  (service.ports ?? []).map((port) => String(port.published))

function verifySharedTopology(config, { production }) {
  const { services } = config
  assert.ok(services.postgres, "shared PostgreSQL service is missing")
  assert.ok(services.redis, "shared Redis service is missing")
  assert.ok(services.filesystem, "shared RustFS service is missing")
  assert.equal(services["zalo-postgres"], undefined)
  assert.equal(services["zalo-redis"], undefined)
  assert.equal(services["zalo-backup"], undefined)
  assert.equal(services.minio, undefined)

  assert.match(services.postgres.image, PG18_PATTERN)
  assert.match(commandText(services.redis), APPEND_ONLY_PATTERN)
  assert.match(commandText(services.redis), APPEND_FSYNC_PATTERN)
  assert.equal(commandText(services.redis).includes("256mb"), false)

  const databaseInit = services["zalo-database-init"]
  assert.ok(databaseInit, "explicit Zalo database bootstrap is missing")
  assert.equal(databaseInit.environment.POSTGRES_HOST, "postgres")
  assert.equal(databaseInit.environment.ZALO_DB_NAME, "zalo_personal")
  assert.equal(databaseInit.environment.ZALO_DB_USER, "zalo_personal")
  assert.equal(databaseInit.environment.ZALO_DB_CONNECTION_LIMIT, "30")

  const filesystemInit = services["zalo-filesystem-init"]
  assert.ok(filesystemInit, "explicit Zalo RustFS bootstrap is missing")
  assert.equal(filesystemInit.environment.ZALO_S3_BUCKET, "zalocrm-attachments")
  assert.equal(
    filesystemInit.environment.ZALO_S3_ACCESS_KEY_ID,
    "zalo-storage-user",
  )
  assert.notEqual(
    filesystemInit.environment.ZALO_S3_ACCESS_KEY_ID,
    fixtureEnvironment.S3_ACCESS_KEY_ID,
  )

  const app = services["zalo-personal"]
  assert.ok(app, "Zalo Personal app service is missing")
  assert.equal(app.environment.REDIS_URL, "redis://redis:6379/1")
  assert.equal(app.environment.S3_ENDPOINT, "http://filesystem:9000")
  assert.equal(app.environment.S3_BUCKET, "zalocrm-attachments")
  assert.deepEqual(publishedPorts(app), ["3080"])
  assert.equal(new URL(app.environment.DATABASE_URL).hostname, "postgres")
  assert.equal(new URL(app.environment.DATABASE_URL).pathname, "/zalo_personal")
  assert.equal(app.environment.ZALO_BRIDGE_SECRET_KEY, "c".repeat(64))

  const gateway = services["zalo-personal-gateway"]
  assert.ok(gateway, "Zalo Personal gateway service is missing")
  assert.equal(commandText(gateway), "node dist/gateway.js")
  assert.deepEqual(publishedPorts(gateway), [])
  assert.equal(gateway.environment.ZALO_PERSONAL_PROVIDER_MODE, "gateway")
  assert.equal(gateway.environment.REDIS_URL, "redis://redis:6379/1")
  assert.equal(gateway.environment.S3_BUCKET, "zalocrm-attachments")
  assert.equal(new URL(gateway.environment.DATABASE_URL).hostname, "postgres")
  assert.equal(
    new URL(gateway.environment.DATABASE_URL).pathname,
    "/zalo_personal",
  )
  assert.equal(gateway.environment.ZALO_GATEWAY_CREDENTIAL_KEY, "b".repeat(64))
  assert.equal(gateway.environment.ZALO_BRIDGE_SECRET_KEY, undefined)
  assert.equal(gateway.environment.ZALO_GATEWAY_CLAIMS_ENABLED, "false")
  assert.equal(gateway.environment.ZALO_GATEWAY_COMMAND_CLAIMS_ENABLED, "false")
  assert.equal(gateway.environment.ZALO_GATEWAY_ACCOUNT_ALLOWLIST, "")

  const worker = services.worker
  assert.ok(worker, "ChatbotX worker service is missing")
  assert.equal(worker.environment.ZALO_PERSONAL_BRIDGE_ENABLED, "false")
  assert.equal(worker.environment.ZALO_PERSONAL_BRIDGE_POLL_ENABLED, "false")
  assert.equal(
    worker.environment.ZALO_PERSONAL_BRIDGE_OUTBOUND_ENABLED,
    "false",
  )
  assert.equal(worker.environment.ZALO_PERSONAL_BRIDGE_ACCOUNT_ALLOWLIST, "")

  if (production) {
    assert.equal(
      app.depends_on,
      undefined,
      "production Zalo must not start shared services through depends_on",
    )
    assert.equal(
      gateway.depends_on,
      undefined,
      "production Zalo gateway must not start shared services through depends_on",
    )
  } else {
    assert.match(commandText(services.redis), NO_EVICTION_PATTERN)
    for (const service of [
      "builder",
      "gateway",
      "worker",
      "realtime",
      "javascript-executor",
    ]) {
      assert.ok(services[service], `development ${service} service is missing`)
    }
    assert.equal(
      services.builder.build.dockerfile,
      "apps/builder/docker/Dockerfile.dev",
    )
    assert.equal(services.builder.environment.RUN_DB_MIGRATE, "false")
    assert.equal(services.builder.environment.RUN_DB_SEED, "false")
    assert.match(
      services.builder.environment.DATABASE_URL,
      CHATBOTX_DATABASE_PATTERN,
    )
    assert.equal(services.builder.environment.REDIS_URL, "redis://redis:6379/0")
  }
}

function verifyQueueInventory() {
  const chatbotxSource = readFileSync(
    path.join(repositoryRoot, "packages/worker-config/src/lib/types.ts"),
    "utf8",
  )
  const zaloFiles = [
    "apps/zalo-personal/backend/src/modules/tags/zalo-label-queue.ts",
    "apps/zalo-personal/backend/src/modules/zalo/group-scan-queue.ts",
  ]
  const stringPattern = /["']([a-z][a-zA-Z0-9-]+)["']/g
  const chatbotxQueues = new Set(
    [...chatbotxSource.matchAll(stringPattern)].map((match) => match[1]),
  )
  const zaloQueues = new Set(
    zaloFiles.flatMap((file) =>
      [
        ...readFileSync(path.join(repositoryRoot, file), "utf8").matchAll(
          stringPattern,
        ),
      ]
        .map((match) => match[1])
        .filter(
          (value) => value === "group-scan" || value === "zalo-label-mutate",
        ),
    ),
  )
  assert.deepEqual([...zaloQueues].sort(), ["group-scan", "zalo-label-mutate"])
  assert.deepEqual(
    [...zaloQueues].filter((queue) => chatbotxQueues.has(queue)),
    [],
    "BullMQ queue names collide across applications",
  )
}

function verifyNoDestructiveProductionCommands() {
  const scripts = [
    "scripts/docker/zalo-personal/production.sh",
    "scripts/docker/production-full.sh",
  ]
  const source = scripts
    .map((file) => readFileSync(path.join(repositoryRoot, file), "utf8"))
    .join("\n")
  for (const forbidden of FORBIDDEN_PRODUCTION_PATTERNS) {
    assert.doesNotMatch(source, forbidden)
  }
}

function verifyOrchestrationContracts() {
  const developmentCompose = readFileSync(
    path.join(repositoryRoot, "docker-compose.dev.yml"),
    "utf8",
  )
  const developmentScript = readFileSync(
    path.join(repositoryRoot, "scripts/docker/development.mjs"),
    "utf8",
  )
  const standaloneScript = readFileSync(
    path.join(repositoryRoot, "scripts/zalo-personal/compose.mjs"),
    "utf8",
  )
  const migrationScript = readFileSync(
    path.join(repositoryRoot, "scripts/zalo-personal/migrate-dev.mjs"),
    "utf8",
  )
  const workflow = readFileSync(
    path.join(repositoryRoot, ".github/workflows/deploy-production.yml"),
    "utf8",
  )
  assert.match(developmentCompose, DEV_OPTIONAL_ENV_FILE_PATTERN)
  assert.doesNotMatch(developmentScript, ZALO_DATA_SERVICE_PATTERN)
  const downAction = standaloneScript.match(DEV_DOWN_ACTION_PATTERN)?.[0]
  assert.ok(downAction, "dev-down action is missing")
  assert.doesNotMatch(downAction, SHARED_STOP_PATTERN)
  assert.match(standaloneScript, DEV_FILESYSTEM_PREPARE_PATTERN)
  assert.match(migrationScript, MIGRATION_FILESYSTEM_PREPARE_PATTERN)
  assert.match(workflow, WORKFLOW_CONTEXT_PATTERN)
  assert.match(workflow, WORKFLOW_ACTIVATION_ENVIRONMENT_PATTERN)
  assert.match(workflow, WORKFLOW_BASELINE_ENVIRONMENT_PATTERN)
  assert.match(workflow, WORKFLOW_DISPATCH_PATTERN)
  assert.match(workflow, WORKFLOW_BOOTSTRAP_LOCK_PATTERN)
}

const development = composeConfig(
  ["docker-compose.dev.yml", "docker-compose.zalo-personal.yml"],
  "prepare",
)
verifySharedTopology(development, { production: false })

const production = composeConfig(
  [
    "docker-compose.production.yml",
    "docker-compose.zalo-personal.production.yml",
  ],
  "bootstrap",
)
verifySharedTopology(production, { production: true })
verifyQueueInventory()
verifyNoDestructiveProductionCommands()
verifyOrchestrationContracts()

// DB0/DB1 prevent accidental key collisions only. Redis clients can SELECT
// another DB and Pub/Sub is instance-wide; ChatbotX's current PostgreSQL role
// is also cluster-admin. These namespaces are not authorization boundaries.
console.log(
  "Shared PostgreSQL/Redis/RustFS Compose contracts and queue inventory passed.",
)
