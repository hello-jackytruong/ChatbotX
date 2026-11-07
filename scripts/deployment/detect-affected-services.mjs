#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

export const SERVICE_DEFINITIONS = Object.freeze([
  {
    label: "builder",
    package: "builder",
    image: "chatbotx-builder",
    context: ".",
    dockerfile: "./apps/builder/docker/Dockerfile",
  },
  {
    label: "worker",
    package: "worker",
    image: "chatbotx-worker",
    context: ".",
    dockerfile: "./apps/worker/docker/Dockerfile",
  },
  {
    label: "realtime",
    package: "realtime",
    image: "chatbotx-realtime",
    context: ".",
    dockerfile: "./apps/realtime/docker/Dockerfile",
  },
  {
    label: "javascript-executor",
    package: "javascript-executor",
    image: "chatbotx-javascript-executor",
    context: ".",
    dockerfile: "./apps/javascript-executor/docker/Dockerfile",
  },
  {
    label: "zalo-personal",
    package: null,
    image: "chatbotx-zalo-personal",
    context: "./apps/zalo-personal",
    dockerfile: "./apps/zalo-personal/docker/Dockerfile",
  },
])

const CHATBOTX_SERVICE_LABELS = new Set([
  "builder",
  "worker",
  "realtime",
  "javascript-executor",
])

const FULL_DEPLOY_PATHS = new Set([
  ".dockerignore",
  ".npmrc",
  ".github/workflows/deploy-production.yml",
  "docker-compose.production.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/deployment/detect-affected-services.mjs",
  "scripts/deployment/production.sh",
  "scripts/docker/production-full.sh",
  "tsconfig.base.json",
  "turbo.json",
])

// Database and migration changes must not leave any long-running application
// on an older schema contract, even when Turborepo reports a narrower graph.
const FULL_DEPLOY_PREFIXES = ["patches/", "packages/database/"]

const EXTRA_SERVICE_PATHS = new Map([
  ["scripts/prune-sourcemaps.mjs", ["worker"]],
])

const ZALO_PATH_PREFIXES = [
  "apps/zalo-personal/",
  "scripts/docker/zalo-personal/",
  "scripts/zalo-personal/",
]
const ZALO_PATHS = new Set([
  "docker-compose.zalo-personal.yml",
  "docker-compose.zalo-personal.production.yml",
])

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/
const GITHUB_REPOSITORY_PART_PATTERN = /^[a-zA-Z0-9_.-]+$/

export async function findLatestSuccessfulProductionDeployment({
  environment,
  fetchImpl = globalThis.fetch,
  repository,
  token,
}) {
  const repositoryParts = repository.split("/")
  if (
    repositoryParts.length !== 2 ||
    repositoryParts.some((part) => !GITHUB_REPOSITORY_PART_PATTERN.test(part))
  ) {
    throw new Error(`Invalid GitHub repository: ${repository}`)
  }
  if (!(environment && token) || typeof fetchImpl !== "function") {
    throw new Error(
      "GitHub repository, environment, token, and fetch implementation are required",
    )
  }

  const [owner, name] = repositoryParts.map(encodeURIComponent)
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "chatbotx-production-deploy",
  }
  const deploymentsUrl = new URL(
    `https://api.github.com/repos/${owner}/${name}/deployments`,
  )
  deploymentsUrl.searchParams.set("environment", environment)
  deploymentsUrl.searchParams.set("per_page", "100")

  const deploymentsResponse = await fetchImpl(deploymentsUrl.href, { headers })
  if (!deploymentsResponse.ok) {
    throw new Error(
      `GitHub deployment history request failed with HTTP ${deploymentsResponse.status}`,
    )
  }
  const deployments = await deploymentsResponse.json()
  if (!Array.isArray(deployments)) {
    throw new Error("GitHub deployment history response is not an array")
  }

  for (const deployment of deployments) {
    if (
      !(
        Number.isSafeInteger(deployment?.id) &&
        GIT_SHA_PATTERN.test(deployment?.sha ?? "")
      )
    ) {
      continue
    }
    const statusesUrl =
      `https://api.github.com/repos/${owner}/${name}/deployments/` +
      `${deployment.id}/statuses?per_page=1`
    const statusesResponse = await fetchImpl(statusesUrl, { headers })
    if (!statusesResponse.ok) {
      throw new Error(
        `GitHub deployment status request failed with HTTP ${statusesResponse.status}`,
      )
    }
    const statuses = await statusesResponse.json()
    if (!Array.isArray(statuses)) {
      throw new Error("GitHub deployment status response is not an array")
    }
    if (statuses[0]?.state === "success") {
      return deployment.sha
    }
  }

  return ""
}

const isFullDeployPath = (path) =>
  FULL_DEPLOY_PATHS.has(path) ||
  FULL_DEPLOY_PREFIXES.some((prefix) => path.startsWith(prefix))

const unique = (values) => [...new Set(values)]

export function selectAffectedServices({
  affectedPackages = [],
  changedFiles = [],
  forceFull = false,
  detectionFailed = false,
} = {}) {
  const globalPath = changedFiles.find(isFullDeployPath)
  if (forceFull || detectionFailed || globalPath) {
    let reason = `global deployment input changed: ${globalPath}`
    if (forceFull) {
      reason = "full deployment requested"
    } else if (detectionFailed) {
      reason =
        "dependency detection failed; using the safe full-deploy fallback"
    }
    return {
      services: SERVICE_DEFINITIONS.map(({ label }) => label),
      reason,
      fullDeploy: true,
    }
  }

  const affected = new Set(affectedPackages)
  const selected = SERVICE_DEFINITIONS.filter(
    ({ package: packageName }) => packageName && affected.has(packageName),
  ).map(({ label }) => label)

  for (const path of changedFiles) {
    for (const service of EXTRA_SERVICE_PATHS.get(path) ?? []) {
      selected.push(service)
    }
    if (
      ZALO_PATHS.has(path) ||
      ZALO_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
    ) {
      selected.push("zalo-personal")
    }
  }

  const services = unique(selected)
  return {
    services,
    reason:
      services.length > 0
        ? `affected application services: ${services.join(", ")}`
        : "no production application service is affected",
    fullDeploy: false,
  }
}

export function buildServiceMatrix(services) {
  const selected = new Set(services)
  const include = SERVICE_DEFINITIONS.filter(({ label }) =>
    selected.has(label),
  ).map(({ package: _package, ...definition }) => definition)

  // GitHub may expand a matrix before evaluating the job-level `if`. Keep the
  // JSON structurally non-empty for a skipped no-service build job.
  return {
    include:
      include.length > 0
        ? include
        : [
            {
              label: "none",
              image: "none",
              context: ".",
              dockerfile: "none",
            },
          ],
  }
}

const parseArguments = (argv) => {
  const args = {
    base: "",
    environment: "production",
    head: "HEAD",
    forceFull: false,
    githubOutput: "",
    repository: "",
    resolveProductionBaseline: false,
    scope: "all",
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--full") {
      args.forceFull = true
    } else if (argument === "--resolve-production-baseline") {
      args.resolveProductionBaseline = true
    } else if (argument === "--base") {
      args.base = argv[index + 1] ?? ""
      index += 1
    } else if (argument === "--head") {
      args.head = argv[index + 1] ?? ""
      index += 1
    } else if (argument === "--github-output") {
      args.githubOutput = argv[index + 1] ?? ""
      index += 1
    } else if (argument === "--github-repository") {
      args.repository = argv[index + 1] ?? ""
      index += 1
    } else if (argument === "--environment") {
      args.environment = argv[index + 1] ?? ""
      index += 1
    } else if (argument === "--scope") {
      args.scope = argv[index + 1] ?? ""
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return args
}

const readChangedFiles = (base, head) =>
  execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMRD", `${base}...${head}`],
    { encoding: "utf8" },
  )
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean)

const readAffectedPackages = (base, head) => {
  const output = execFileSync(
    "pnpm",
    ["turbo", "ls", "--affected", "--output=json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TURBO_SCM_BASE: base,
        TURBO_SCM_HEAD: head,
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  )
  const result = JSON.parse(output)
  return (result.packages?.items ?? []).map(({ name }) => name)
}

const writeGithubOutput = (path, result) => {
  const chatbotxServices = result.services.filter((service) =>
    CHATBOTX_SERVICE_LABELS.has(service),
  )
  appendFileSync(
    path,
    [
      `has_services=${result.services.length > 0}`,
      `services=${result.services.join(",")}`,
      `chatbotx_services=${chatbotxServices.join(",")}`,
      `deploy_zalo=${result.services.includes("zalo-personal")}`,
      `matrix=${JSON.stringify(buildServiceMatrix(result.services))}`,
      `full_deploy=${result.fullDeploy}`,
      `reason=${result.reason}`,
      "",
    ].join("\n"),
  )
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (args.resolveProductionBaseline) {
    const sha = await findLatestSuccessfulProductionDeployment({
      environment: args.environment,
      repository: args.repository,
      token: process.env.GITHUB_TOKEN ?? "",
    })
    process.stdout.write(`${sha}\n`)
    return
  }

  let changedFiles = []
  let affectedPackages = []
  let detectionFailed = false

  if (!(args.forceFull || args.base)) {
    throw new Error("--base is required unless --full is used")
  }

  if (!args.forceFull) {
    try {
      changedFiles = readChangedFiles(args.base, args.head)
      affectedPackages = readAffectedPackages(args.base, args.head)
    } catch (error) {
      detectionFailed = true
      console.error(
        `Affected-service detection failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const result = selectAffectedServices({
    affectedPackages,
    changedFiles,
    forceFull: args.forceFull,
    detectionFailed,
  })
  if (!new Set(["all", "chatbotx", "zalo"]).has(args.scope)) {
    throw new Error(`Invalid deployment scope: ${args.scope}`)
  }
  if (args.scope === "chatbotx") {
    result.services = result.services.filter((service) =>
      CHATBOTX_SERVICE_LABELS.has(service),
    )
  } else if (args.scope === "zalo") {
    result.services = result.services.filter(
      (service) => service === "zalo-personal",
    )
  }
  const output = {
    ...result,
    changedFiles,
    affectedPackages,
    matrix: buildServiceMatrix(result.services),
  }

  console.error(result.reason)
  if (args.githubOutput) {
    writeGithubOutput(args.githubOutput, result)
  } else {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
