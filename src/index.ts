/**
 * Entry point for the structured, non-executing trading research worker.
 *
 * The worker starts a managed local OpenCode server, creates an isolated session
 * for each sequential research cycle, and runs until a process signal or cycle
 * limit stops it. Every cycle selects the checked-in, deny-by-default research
 * agent, while `startOpencode` owns cleanup of the server and its MCP
 * descendants.
 */

import { mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"

import { parse as parseEnv } from "dotenv"

import { runAgentLoop } from "./agent-loop.js"
import { runWithCycleDeadline } from "./cycle-deadline.js"
import {
  createResearchLifecycleRecorder,
  LedgerPersistenceError,
} from "./event-ledger/research-lifecycle-recorder.js"
import { createSqliteLedgerStore } from "./event-ledger/sqlite-ledger-store.js"
import { createAlpacaOptionQuoteProvider } from "./market-data/alpaca-option-quotes.js"
import { createAlpacaCalendarClient } from "./market-data/alpaca-calendar-client.js"
import { startOpencode } from "./opencode-runtime.js"
import {
  buildResearchCyclePrompt,
  RESEARCH_AGENT_NAME,
} from "./research/research-agent.js"
import { writeResearchCycleArtifact } from "./research/research-artifact.js"
import {
  loadResearchContextV1,
  reconstructResearchContextV1,
} from "./research/research-context-v1.js"
import { processResearchCycle } from "./research/research-cycle.js"
import {
  DEFAULT_PREMARKET_RESEARCH_START_ET,
  evaluateResearchEligibility,
  newYorkDate,
} from "./scheduling/research-eligibility.js"

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

class WorkerFatalError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "WorkerFatalError"
  }
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
const alpacaApiKey = readRequiredSetting("ALPACA_API_KEY")
const alpacaSecretKey = readRequiredSetting("ALPACA_SECRET_KEY")
const knownCredentialValues = [
  alpacaApiKey,
  alpacaSecretKey,
  readSetting("FMP_API_KEY")?.trim(),
  readSetting("EXA_API_KEY")?.trim(),
].filter((value): value is string => value !== undefined && value.length > 0)
const quoteProvider = createAlpacaOptionQuoteProvider({
  apiKey: alpacaApiKey,
  secretKey: alpacaSecretKey,
  baseUrl:
    readSetting("ALPACA_MARKET_DATA_BASE_URL")?.trim() ||
    "https://data.alpaca.markets",
})
const calendar = createAlpacaCalendarClient({
  apiKey: alpacaApiKey,
  secretKey: alpacaSecretKey,
  baseUrl:
    readSetting("ALPACA_TRADING_BASE_URL")?.trim() ||
    "https://paper-api.alpaca.markets",
})
const premarketStartEt =
  readSetting("AGENT_PREMARKET_START_ET")?.trim() ||
  DEFAULT_PREMARKET_RESEARCH_START_ET
// Validate configured wall time before starting any external process.
evaluateResearchEligibility({
  evaluatedAt: new Date(),
  premarketStartEt,
})
const ledgerPath = readSetting("RESEARCH_LEDGER_PATH")?.trim() ||
  ".state/research-ledger.sqlite"
mkdirSync(dirname(ledgerPath), { recursive: true })
const ledgerStore = createSqliteLedgerStore({
  path: ledgerPath,
  knownCredentialValues,
})

try {
  await ledgerStore.migrate(abortController.signal)
  let researchContext = await reconstructResearchContextV1(ledgerStore)
  const lifecycleRecorder = createResearchLifecycleRecorder({ store: ledgerStore })
  const runtime = await startOpencode({
    port,
    signal: abortController.signal,
    timeoutMs: serverTimeout,
  })

  try {
    const cycleNumbers = new Map<number, number>()
    await runAgentLoop({
      intervalMs,
      maxCycles,
      signal: abortController.signal,
      runCycle: async (attempt) => {
        const eligibilityEvaluatedAt = new Date()
        const calendarSignal = AbortSignal.any([
          abortController.signal,
          AbortSignal.timeout(cycleTimeoutMs),
        ])
        const session = await calendar.getSession(
          newYorkDate(eligibilityEvaluatedAt),
          calendarSignal,
        )
        const initialEligibility = evaluateResearchEligibility({
          evaluatedAt: new Date(),
          ...(session === undefined ? {} : { session }),
          premarketStartEt,
        })
        const getEligibility = () =>
          evaluateResearchEligibility({
            evaluatedAt: new Date(),
            ...(session === undefined ? {} : { session }),
            premarketStartEt,
            tradeIntentWindow: initialEligibility.tradeIntentWindow ?? null,
          })
        if (!initialEligibility.researchEligible) {
          return `Research cycle skipped: ${initialEligibility.reason ?? "RESEARCH_WINDOW_INELIGIBLE"}`
        }
        const sessionDate = initialEligibility.sessionDate
        if (sessionDate === undefined) {
          throw new WorkerFatalError("Eligible research cycle has no session date")
        }
        const created = await runtime.client.session.create({
          body: { title: `trading-agent ${new Date().toISOString()}` },
        })
        if (!created.data) {
          throw formatApiError("Creating OpenCode session", created.error)
        }
        const sessionId = created.data.id
        const synchronizeSessionAbort = async (operation: string) => {
          try {
            const aborted = await runtime.client.session.abort({
              path: { id: sessionId },
              signal: AbortSignal.timeout(cycleAbortTimeoutMs),
            })
            return typeof aborted.data === "boolean"
              ? undefined
              : formatApiError(operation, aborted.error)
          } catch (error) {
            return formatApiError(operation, error)
          }
        }
        const deleteSession = async () => {
          try {
            const deleted = await runtime.client.session.delete({
              path: { id: sessionId },
              signal: AbortSignal.timeout(cycleAbortTimeoutMs),
            })
            if (deleted.data !== true) {
              throw formatApiError("Deleting completed OpenCode session", deleted.error)
            }
          } catch (error) {
            if (abortController.signal.aborted) return
            if (error instanceof WorkerFatalError) throw error
            throw new WorkerFatalError(
              "Deleting completed OpenCode session failed",
              error,
            )
          }
        }

        let cycle
        try {
          await lifecycleRecorder.recordOpenCodeSessionStarted(
            sessionId,
            abortController.signal,
          )
          try {
            researchContext = await loadResearchContextV1(ledgerStore)
          } catch (error) {
            throw new LedgerPersistenceError("context query", error)
          }
          const cycleNumber = researchContext.nextCycleNumber
          cycleNumbers.set(attempt, cycleNumber)
          cycle = await lifecycleRecorder.startCycle({
            sessionId,
            cycleNumber,
            signal: abortController.signal,
          })
        } catch (error) {
          abortController.abort(error)
          throw error
        }
        console.log(`OpenCode session ${sessionId} started at ${runtime.url}`)
        const cycleNumber = cycle.cycleNumber

        const interruptCycle = async (
          reason: Parameters<typeof cycle.interrupt>[0],
        ) => {
          try {
            await cycle.interrupt(
              reason,
              AbortSignal.timeout(cycleAbortTimeoutMs),
            )
          } catch (error) {
            abortController.abort(error)
            throw error
          }
        }
        const tools = Object.fromEntries(
          MUTATING_ALPACA_TOOLS.map((tool) => [tool, false]),
        )
        let timedOut = false

        try {
          const processed = await runWithCycleDeadline({
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
                      text: buildResearchCyclePrompt(
                        cycleNumber,
                        new Date(cycle.startedAt),
                        task,
                        researchContext,
                        initialEligibility,
                      ),
                    },
                  ],
                },
              })
              if (!response.data) {
                throw formatApiError("Prompting OpenCode session", response.error)
              }

              const text = response.data.parts
                .filter((part) => part.type === "text")
                .map((part) => part.text.trim())
                .filter(Boolean)
                .join("\n")

              return processResearchCycle({
                rawResponse: text,
                cycleStartedAt: cycle.startedAt,
                signal,
                quoteProvider,
                outcomeSink: cycle.outcomeSink,
                getEligibility,
              })
            },
            onTimeout: async () => {
              timedOut = true
              const failure = await synchronizeSessionAbort(
                "Aborting timed-out OpenCode session",
              )

              await interruptCycle("TIMEOUT")
              if (failure) {
                console.error(failure.message)
                const fatal = new WorkerFatalError(failure.message, failure)
                abortController.abort(fatal)
                throw fatal
              }
            },
          })
          try {
            const artifactPath = await writeResearchCycleArtifact({
              cycleId: cycle.cycleId,
              cycleNumber,
              sessionDate,
              outcome: processed.outcome,
              ...(processed.researchReport === undefined
                ? {}
                : { researchReport: processed.researchReport }),
            })
            return `${processed.report}\nResearch artifact: ${artifactPath}`
          } catch {
            console.error(
              `[cycle ${cycleNumber}] validated outcome recorded, but research artifact could not be written`,
            )
            return `${processed.report}\nResearch artifact: unavailable`
          }
        } catch (error) {
          if (error instanceof LedgerPersistenceError) {
            abortController.abort(error)
          } else if (abortController.signal.aborted) {
            await interruptCycle(timedOut ? "TIMEOUT" : "SHUTDOWN")
          } else if (!timedOut) {
            const abortFailure = await synchronizeSessionAbort(
              "Aborting failed OpenCode session",
            )
            await interruptCycle("FAILED")
            if (abortFailure) {
              const fatal = new WorkerFatalError(
                abortFailure.message,
                abortFailure,
              )
              abortController.abort(fatal)
              throw fatal
            }
          }
          throw error
        } finally {
          if (!abortController.signal.aborted) await deleteSession()
        }
      },
      onResult: (result, attempt) =>
        console.log(`[cycle ${cycleNumbers.get(attempt) ?? attempt}]\n${result}`),
      onError: (error, attempt) =>
        console.error(
          `[cycle ${cycleNumbers.get(attempt) ?? attempt}] failed`,
          error,
        ),
      isFatalError: (error) =>
        error instanceof LedgerPersistenceError ||
        error instanceof WorkerFatalError,
    })
  } finally {
    await runtime.close()
  }
} finally {
  await ledgerStore.close()
}
