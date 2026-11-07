import { spawn } from "node:child_process"
import process from "node:process"

const inheritedPnpmSettings = [
  "npm_config__jsr_registry",
  "npm_config_catalog",
  "npm_config_catalog_mode",
  "npm_config_npm_globalconfig",
  "npm_config_user_agent",
  "npm_config_verify_deps_before_run",
]
const environment = { ...process.env }
for (const key of inheritedPnpmSettings) {
  delete environment[key]
}

const command = process.platform === "win32" ? "npm.cmd" : "npm"
const child = spawn(command, process.argv.slice(2), {
  env: environment,
  stdio: "inherit",
})

child.on("error", (error) => {
  console.error(error.message)
  process.exit(1)
})
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
  } else {
    process.exit(code ?? 1)
  }
})
