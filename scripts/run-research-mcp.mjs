/**
 * Starts one approved research MCP with only the credentials it requires.
 *
 * OpenCode receives this launcher path rather than secret-bearing command
 * arguments. The launcher reads the project environment privately, constructs
 * a minimal child environment, and never writes credential values to output.
 */

import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

import { parse as parseEnv } from "dotenv"

const fileEnv = (() => {
  try {
    return parseEnv(readFileSync(".env"))
  } catch (error) {
    if (error.code === "ENOENT") return {}
    throw error
  }
})()

const readRequiredSetting = (name) => {
  const value = (process.env[name] ?? fileEnv[name])?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const baseEnvironment = Object.fromEntries(
  ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"].flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]],
  ),
)

const createServers = {
  alpaca: () => ({
    command: "uvx",
    args: ["--from", "alpaca-mcp-server==2.2.1", "alpaca-mcp-server"],
    environment: {
      ALPACA_API_KEY: readRequiredSetting("ALPACA_API_KEY"),
      ALPACA_SECRET_KEY: readRequiredSetting("ALPACA_SECRET_KEY"),
      ALPACA_PAPER_TRADE: "true",
    },
  }),
  fmp: () => ({
    command: "npx",
    args: [
      "-y",
      "mcp-remote@0.1.49",
      `https://financialmodelingprep.com/mcp?apikey=${readRequiredSetting("FMP_API_KEY")}`,
      "--transport",
      "http-first",
    ],
    environment: {},
  }),
  exa: () => ({
    command: "npx",
    args: ["-y", "exa-mcp-server@3.4.1"],
    environment: { EXA_API_KEY: readRequiredSetting("EXA_API_KEY") },
  }),
}

const name = process.argv[2]
const createServer = createServers[name]
if (!createServer) throw new Error("Unknown research MCP server")
const server = createServer()

const child = spawn(server.command, server.args, {
  env: { ...baseEnvironment, ...server.environment },
  stdio: "inherit",
  windowsHide: true,
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal))
}

child.once("error", () => {
  process.exitCode = 1
})
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1)
})
