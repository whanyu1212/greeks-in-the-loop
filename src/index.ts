/**
 * Entry point for the structured, non-executing trading research worker.
 *
 * The worker starts a managed local OpenCode server, creates one persistent
 * session, and runs sequential research cycles until a process signal or cycle
 * limit stops it. Every cycle selects the checked-in, deny-by-default research
 * agent, while `startOpencode` owns cleanup of the server and its MCP
 * descendants.
 */

import { readFileSync } from "node:fs"

import { parse as parseEnv } from "dotenv"

import { runAgentLoop } from "./agent-loop.js"
import { runWithCycleDeadline } from "./cycle-deadline.js"
import { createAlpacaOptionQuoteProvider } from "./market-data/alpaca-option-quotes.js"
import { startOpencode } from "./opencode-runtime.js"
import {
  buildResearchCyclePrompt,
  RESEARCH_AGENT_NAME,
} from "./research/research-agent.js"
import { processResearchCycle } from "./research/research-cycle.js"
import { createConsoleResearchCycleOutcomeSink } from "./research/research-cycle-outcome-v1.js"

/** Settings parsed from the project environment file without exporting secrets. */
const fileEnv = (() => {
  try {
    return parseEnv(readFileSync(".env"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
})()

/**
 * Reads a setting, preferring the process environment over the project file.
 *
 * @param name Environment variable name.
 * @returns The configured value, or `undefined` when it is absent.
 */
const readSetting = (name: string) => process.env[name] ?? fileEnv[name]

/**
 * Reads a required non-empty setting without including its value in failures.
 *
 * @param name Environment variable name.
 * @returns The configured non-empty value.
 * @throws If the setting is absent or blank.
 */
const readRequiredSetting = (name: string) => {
  const value = readSetting(name)?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

/**
 * Alpaca tools unavailable to the non-executing research agent.
 *
 * Keep this list synchronized with the tools exposed by the configured Alpaca
 * MCP server. OpenCode disables exact tool names only, so an MCP upgrade that
 * introduces a new mutation requires an explicit audit and list update.
 */
const MUTATING_ALPACA_TOOLS = [
  "alpaca_place_stock_order",
  "alpaca_place_crypto_order",
  "alpaca_place_option_order",
  "alpaca_create_locate",
  "alpaca_update_account_config",
  "alpaca_cancel_all_orders",
  "alpaca_cancel_order_by_id",
  "alpaca_replace_order_by_id",
  "alpaca_close_all_positions",
  "alpaca_close_position",
  "alpaca_do_not_exercise_options_position",
  "alpaca_exercise_options_position",
  "alpaca_create_watchlist",
  "alpaca_update_watchlist_by_id",
  "alpaca_add_asset_to_watchlist_by_id",
  "alpaca_delete_watchlist_by_id",
  "alpaca_remove_asset_from_watchlist_by_id",
] as const

/**
 * Reads and validates a positive integer setting.
 *
 * @param name Environment variable name.
 * @param fallback Value to use when the setting is absent.
 * @returns The validated positive integer.
 * @throws If the configured value is not a positive safe integer.
 */
const readPositiveInteger = (name: string, fallback: number) => {
  const raw = readSetting(name)
  if (raw === undefined) return fallback

  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/**
 * Creates a bounded error message for an unsuccessful SDK operation.
 *
 * The original error payload is not included because provider errors may
 * contain request details that should not be printed to logs.
 *
 * @param operation Human-readable operation name.
 * @param error Error payload returned by the SDK.
 * @returns A safe error suitable for application logs.
 */
const formatApiError = (operation: string, error: unknown) => {
  const detail =
    typeof error === "object" && error !== null && "name" in error
      ? ` (${String(error.name)})`
      : ""
  return new Error(`${operation} failed${detail}`)
}

const abortController = new AbortController()
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => abortController.abort(new Error(`Received ${signal}`)))
}

const once = process.argv.includes("--once")
const intervalMs = readPositiveInteger("AGENT_INTERVAL_MS", 5 * 60 * 1000)
const cycleTimeoutMs = readPositiveInteger("AGENT_CYCLE_TIMEOUT_MS", 2 * 60 * 1000)
const cycleAbortTimeoutMs = readPositiveInteger("AGENT_CYCLE_ABORT_TIMEOUT_MS", 5_000)
const maxCycles = once
  ? 1
  : readPositiveInteger("AGENT_MAX_CYCLES", Number.MAX_SAFE_INTEGER)
const port = readPositiveInteger("OPENCODE_SERVER_PORT", 4096)
const serverTimeout = readPositiveInteger("OPENCODE_SERVER_TIMEOUT_MS", 60_000)
const task = readSetting("AGENT_TASK")?.trim()
const quoteProvider = createAlpacaOptionQuoteProvider({
  apiKey: readRequiredSetting("ALPACA_API_KEY"),
  secretKey: readRequiredSetting("ALPACA_SECRET_KEY"),
  baseUrl:
    readSetting("ALPACA_MARKET_DATA_BASE_URL")?.trim() ||
    "https://data.alpaca.markets",
})
const outcomeSink = createConsoleResearchCycleOutcomeSink()

const runtime = await startOpencode({
  port,
  signal: abortController.signal,
  timeoutMs: serverTimeout,
})

try {
  const created = await runtime.client.session.create({
    body: { title: `trading-agent ${new Date().toISOString()}` },
  })
  if (!created.data) throw formatApiError("Creating OpenCode session", created.error)

  const sessionId = created.data.id
  console.log(`OpenCode session ${sessionId} started at ${runtime.url}`)

  await runAgentLoop({
    intervalMs,
    maxCycles,
    signal: abortController.signal,
    runCycle: async (cycle) => {
      const tools = Object.fromEntries(MUTATING_ALPACA_TOOLS.map((tool) => [tool, false]))

      return runWithCycleDeadline({
        timeoutMs: cycleTimeoutMs,
        shutdownSignal: abortController.signal,
        run: async (signal) => {
          const response = await runtime.client.session.prompt({
            path: { id: sessionId },
            signal,
            body: {
              agent: RESEARCH_AGENT_NAME,
              tools,
              parts: [
                {
                  type: "text",
                  text: buildResearchCyclePrompt(cycle, new Date(), task),
                },
              ],
            },
          })
          if (!response.data) throw formatApiError("Prompting OpenCode session", response.error)

          const text = response.data.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text.trim())
            .filter(Boolean)
            .join("\n")

          const processed = await processResearchCycle({
            rawResponse: text,
            signal,
            quoteProvider,
            outcomeSink,
          })
          return processed.report
        },
        onTimeout: async () => {
          let failure: Error | undefined

          try {
            const aborted = await runtime.client.session.abort({
              path: { id: sessionId },
              signal: AbortSignal.timeout(cycleAbortTimeoutMs),
            })
            if (typeof aborted.data !== "boolean") {
              failure = formatApiError("Aborting timed-out OpenCode session", aborted.error)
            }
          } catch (error) {
            failure = formatApiError("Aborting timed-out OpenCode session", error)
          }

          if (failure) {
            console.error(failure.message)
            abortController.abort(failure)
            throw failure
          }
        },
      })
    },
  })
} finally {
  await runtime.close()
}
