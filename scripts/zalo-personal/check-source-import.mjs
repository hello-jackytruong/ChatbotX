import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"

const repositoryRoot = path.resolve(import.meta.dirname, "../..")
const sourceRoot = path.join(repositoryRoot, "apps/zalo-personal")
const forbiddenDirectories = new Set([
  ".data",
  ".git",
  "backups",
  "coverage",
  "dist",
  "node_modules",
  "uploads",
])
const forbiddenFiles = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.test",
])
const requiredFiles = [
  "LICENSE",
  "backend/package.json",
  "backend/prisma/schema.prisma",
  "backend/contracts/baseline/database-contract.json",
  "frontend/package.json",
  "docker/Dockerfile",
]

const violations = []

if (!fs.existsSync(sourceRoot)) {
  throw new Error(`Missing imported source: ${sourceRoot}`)
}

const sourceEntries = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "apps/zalo-personal",
  ],
  { cwd: repositoryRoot, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)

for (const repositoryRelative of sourceEntries) {
  const relative = path.relative("apps/zalo-personal", repositoryRelative)
  const parts = relative.split(path.sep)
  const fileName = parts.at(-1) ?? ""
  const forbiddenDirectory = parts.find((part) =>
    forbiddenDirectories.has(part),
  )
  if (forbiddenDirectory) {
    violations.push(`forbidden directory: ${relative}`)
  }
  if (
    forbiddenFiles.has(fileName) ||
    (fileName.startsWith(".env.") && fileName !== ".env.example")
  ) {
    violations.push(`forbidden environment file: ${relative}`)
  }
  if (/\.(?:pem|key|p12|pfx)$/i.test(fileName)) {
    violations.push(`forbidden credential file: ${relative}`)
  }
}

for (const relative of requiredFiles) {
  if (!fs.existsSync(path.join(sourceRoot, relative))) {
    violations.push(`missing required file: ${relative}`)
  }
}

const backendPackage = JSON.parse(
  fs.readFileSync(path.join(sourceRoot, "backend/package.json"), "utf8"),
)
const frontendPackage = JSON.parse(
  fs.readFileSync(path.join(sourceRoot, "frontend/package.json"), "utf8"),
)
if (backendPackage.name !== "@chatbotx.io/zalo-personal-backend") {
  violations.push(`unexpected backend package name: ${backendPackage.name}`)
}
if (frontendPackage.name !== "@chatbotx.io/zalo-personal-web") {
  violations.push(`unexpected frontend package name: ${frontendPackage.name}`)
}

const schema = fs.readFileSync(
  path.join(sourceRoot, "backend/prisma/schema.prisma"),
  "utf8",
)
const modelCount = [...schema.matchAll(/^model\s+\w+\s*\{/gm)].length
if (modelCount < 108) {
  violations.push(`expected at least 108 Prisma models, found ${modelCount}`)
}

const license = fs.readFileSync(path.join(sourceRoot, "LICENSE"), "utf8")
if (!license.includes("MIT License")) {
  violations.push("LICENSE is not the expected MIT license")
}

if (violations.length > 0) {
  console.error(violations.join("\n"))
  process.exit(1)
}

console.log(
  `Zalo Personal source guard passed: ${modelCount} Prisma models; no forbidden artifacts.`,
)
