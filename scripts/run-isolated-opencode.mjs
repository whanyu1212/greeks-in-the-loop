/**
 * Runs an OpenCode diagnostic with the worker's configuration isolation.
 *
 * Provider authentication remains in OpenCode's data directory, while a
 * temporary XDG config home prevents user-global plugins, MCPs, and agents from
 * entering the resolved project boundary.
 */

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const configHome = mkdtempSync(join(tmpdir(), "greeks-opencode-check-"))
const {
  OPENCODE_CONFIG: _configPath,
  OPENCODE_CONFIG_CONTENT: _configContent,
  OPENCODE_CONFIG_DIR: _configDirectory,
  OPENCODE_AGENT: _agentOverride,
  ...environment
} = process.env

const child = spawn("opencode", ["--pure", ...process.argv.slice(2)], {
  env: { ...environment, XDG_CONFIG_HOME: configHome },
  stdio: "inherit",
  windowsHide: true,
})

const cleanup = () => rmSync(configHome, { force: true, recursive: true })
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal))
}

child.once("error", () => {
  cleanup()
  process.exitCode = 1
})
child.once("exit", (code, signal) => {
  cleanup()
  process.exitCode = signal ? 1 : (code ?? 1)
})
