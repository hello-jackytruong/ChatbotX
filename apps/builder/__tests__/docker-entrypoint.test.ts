import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../docker/rootfs/usr/local/bin/docker-entrypoint.sh",
)

let executableDir: string

function run(env: Record<string, string> = {}): {
  stdout: string
  status: number
} {
  try {
    const stdout = execFileSync("sh", [SCRIPT, "serve"], {
      env: {
        ...process.env,
        PATH: `${executableDir}:${process.env.PATH ?? ""}`,
        RUN_DB_MIGRATE: "false",
        RUN_DB_SEED: "false",
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { stdout, status: 0 }
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string }
    return {
      stdout: `${err.stdout ?? ""}${err.stderr ?? ""}`,
      status: err.status ?? 1,
    }
  }
}

beforeEach(() => {
  executableDir = mkdtempSync(join(tmpdir(), "builder-entrypoint-"))
  const fakeNode = join(executableDir, "node")
  writeFileSync(
    fakeNode,
    '#!/bin/sh\nprintf "%s|%s|%s|%s\\n" "$NODE_OPTIONS" "$HOSTNAME" "$PORT" "$*"\n',
  )
  chmodSync(fakeNode, 0o755)
})

afterEach(() => {
  rmSync(executableDir, { recursive: true, force: true })
})

describe("builder docker entrypoint", () => {
  test("preserves the configured heap limit and appends runtime diagnostics", () => {
    const result = run({ NODE_OPTIONS: "--max-old-space-size=1024" })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("--max-old-space-size=1024")
    expect(result.stdout).toContain("--no-node-snapshot")
    expect(result.stdout).toContain("--enable-source-maps")
    expect(result.stdout).toContain("|0.0.0.0|3000|apps/builder/server.js")
  })

  test("ignores Docker's container-id hostname unless BUILDER_HOST is set", () => {
    const defaultHost = run({ HOSTNAME: "container-id" })
    const configuredHost = run({
      BUILDER_HOST: "127.0.0.1",
      HOSTNAME: "container-id",
      PORT: "3123",
    })

    expect(defaultHost.stdout).toContain("|0.0.0.0|3000|")
    expect(configuredHost.stdout).toContain("|127.0.0.1|3123|")
  })
})
