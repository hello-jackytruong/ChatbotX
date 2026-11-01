import assert from "node:assert/strict"
import test from "node:test"
import {
  buildServiceMatrix,
  findLatestSuccessfulProductionDeployment,
  selectAffectedServices,
} from "./detect-affected-services.mjs"

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  json: async () => body,
  ok,
  status,
})

const DEPLOYMENT_STATUS_URL_PATTERN = /deployments\/(\d+)\/statuses/

test("uses the latest successful production deployment as the cumulative base", async () => {
  const successfulSha = "1".repeat(40)
  const seenRequests = []
  const fetchImpl = (url, options) => {
    seenRequests.push({ options, url })
    if (url.includes("/deployments?")) {
      return jsonResponse([
        { id: 3, sha: "3".repeat(40) },
        { id: 2, sha: "2".repeat(40) },
        { id: 1, sha: successfulSha },
      ])
    }
    const deploymentId = url.match(DEPLOYMENT_STATUS_URL_PATTERN)?.[1]
    const states = {
      1: "success",
      2: "failure",
      3: "in_progress",
    }
    return jsonResponse([
      {
        state: states[deploymentId] ?? "failure",
      },
    ])
  }

  const baseline = await findLatestSuccessfulProductionDeployment({
    environment: "production",
    fetchImpl,
    repository: "owner/repository",
    token: "test-token",
  })
  assert.equal(baseline, successfulSha)
  assert.equal(
    seenRequests[0]?.options.headers.Authorization,
    "Bearer test-token",
  )
})

test("fails closed when production deployment history is unavailable", async () => {
  await assert.rejects(
    findLatestSuccessfulProductionDeployment({
      environment: "production",
      fetchImpl: async () => jsonResponse({}, { ok: false, status: 503 }),
      repository: "owner/repository",
      token: "test-token",
    }),
    {
      message: "GitHub deployment history request failed with HTTP 503",
    },
  )
})

test("requests a full deployment when no successful production baseline exists", async () => {
  const baseline = await findLatestSuccessfulProductionDeployment({
    environment: "production",
    fetchImpl: () => jsonResponse([]),
    repository: "owner/repository",
    token: "test-token",
  })

  assert.equal(baseline, "")
})

test("selects only applications reported by the dependency graph", () => {
  assert.deepEqual(
    selectAffectedServices({
      affectedPackages: ["builder", "@chatbotx.io/ui"],
      changedFiles: ["apps/builder/src/page.tsx"],
    }).services,
    ["builder"],
  )
})

test("selects multiple applications affected by a shared package", () => {
  assert.deepEqual(
    selectAffectedServices({
      affectedPackages: ["builder", "worker", "@chatbotx.io/events"],
      changedFiles: ["packages/events/src/index.ts"],
    }).services,
    ["builder", "worker"],
  )
})

test("uses a full deployment for global build inputs", () => {
  const result = selectAffectedServices({
    affectedPackages: ["builder"],
    changedFiles: ["pnpm-lock.yaml"],
  })
  assert.equal(result.fullDeploy, true)
  assert.deepEqual(result.services, [
    "builder",
    "worker",
    "realtime",
    "javascript-executor",
  ])
})

test("uses a full deployment for database and migration changes", () => {
  const result = selectAffectedServices({
    changedFiles: ["packages/database/prisma/schema.prisma"],
    affectedPackages: ["builder", "worker"],
  })

  assert.equal(result.fullDeploy, true)
  assert.deepEqual(result.services, [
    "builder",
    "worker",
    "realtime",
    "javascript-executor",
  ])
})

test("uses a full deployment when dependency detection fails", () => {
  assert.equal(
    selectAffectedServices({ detectionFailed: true }).services.length,
    4,
  )
})

test("adds Docker build inputs outside a workspace to their service", () => {
  assert.deepEqual(
    selectAffectedServices({
      changedFiles: ["scripts/prune-sourcemaps.mjs"],
    }).services,
    ["worker"],
  )
})

test("returns a valid placeholder matrix when no app is affected", () => {
  assert.deepEqual(buildServiceMatrix([]), {
    include: [{ label: "none", image: "none", dockerfile: "none" }],
  })
})
