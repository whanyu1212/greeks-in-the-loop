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

import {
  AgentLoopBreakerLatchedError,
  DEFAULT_AGENT_MAX_BACKOFF_MS,
  DEFAULT_AGENT_MAX_CONSECUTIVE_FAILURES,
  MAX_AGENT_LOOP_DELAY_MS,
  runAgentLoop,
} from "./agent-loop.js"
import { parseAgentOptions } from "./agent-options.js"
import { acquireWorkerInstanceLock } from "./worker-instance-lock.js"
import { runWithCycleDeadline } from "./cycle-deadline.js"
import {
  createResearchLifecycleRecorder,
  LedgerPersistenceError,
} from "./event-ledger/research-lifecycle-recorder.js"
import { createSqliteLedgerStore } from "./event-ledger/sqlite-ledger-store.js"
import { createAlpacaOptionQuoteProvider } from "./market-data/alpaca-option-quotes.js"
import { createAlpacaOptionUniverseProvider } from "./market-data/alpaca-option-universe.js"
import { createAlpacaCalendarClient } from "./market-data/alpaca-calendar-client.js"
import { summarizeOpenCodeInvocation } from "./observability/opencode-telemetry-summary.js"
import { startResearchTelemetry } from "./observability/research-telemetry.js"
import {
  createTerminalStageReporter,
  resolveTerminalLogFormat,
} from "./observability/terminal-stage-reporter.js"
import {
  assertResearchModelIdentityV1,
  createResearchInvocationV1,
  RESEARCH_INVOCATION_PROVENANCE_BY_VERSION,
  RESEARCH_INVOCATION_VERSION,
  type ResearchInvocationV1,
} from "./research/invocation.js"
import { startOpencode } from "./opencode-runtime.js"
import {
  buildResearchCyclePrompt,
  buildResearchReportRepairPrompt,
  researchToolBudgetViolation,
} from "./research/agent.js"
import { loadResearchRunV1 } from "./research/run/artifact.js"
import {
  buildResearchRunPresentation,
  writeResearchRunArtifacts,
} from "./research/run/presentation.js"
import {
  loadResearchContextV1,
  reconstructResearchContextV1,
} from "./research/context.js"
import {
  processResearchCycle,
  repairResearchReportV7ResponseOnce,
} from "./research/cycle.js"
import { screenOptionUniverseV2 } from "./research/symbol-screen.js"
import { createAlpacaRiskStateProvider } from "./risk/alpaca-risk-state-provider.js"
import {
  createLedgerDurableRiskControlStateLoader,
  createShadowRiskEvaluator,
} from "./risk/shadow-risk-service.js"
import {
  DEFAULT_PREMARKET_RESEARCH_START_ET,
  DRY_RUN_MODE,
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

const agentOptions = parseAgentOptions(
  process.argv.slice(2),
  readSetting("RESEARCH_LEDGER_PATH"),
)
const { once, dryRun, ledgerPath } = agentOptions
const breakerResetInstruction =
  `run pnpm agent:reset-breaker -- --ledger <ledger-path> for ${JSON.stringify(ledgerPath)}`
const researchMode = dryRun ? DRY_RUN_MODE : undefined
const intervalMs = readPositiveInteger("AGENT_INTERVAL_MS", 5 * 60 * 1000)
const maxBackoffMs = readPositiveInteger(
  "AGENT_MAX_BACKOFF_MS",
  DEFAULT_AGENT_MAX_BACKOFF_MS,
)
const maxConsecutiveFailures = readPositiveInteger(
  "AGENT_MAX_CONSECUTIVE_FAILURES",
  DEFAULT_AGENT_MAX_CONSECUTIVE_FAILURES,
)
if (maxBackoffMs / 2 < intervalMs) {
  throw new Error("AGENT_MAX_BACKOFF_MS must be at least twice AGENT_INTERVAL_MS")
}
if (maxBackoffMs > MAX_AGENT_LOOP_DELAY_MS) {
  throw new Error(`AGENT_MAX_BACKOFF_MS must not exceed ${MAX_AGENT_LOOP_DELAY_MS}`)
}
const cycleTimeoutMs = dryRun && readSetting("AGENT_CYCLE_TIMEOUT_MS") === undefined
  ? undefined
  : readPositiveInteger("AGENT_CYCLE_TIMEOUT_MS", 10 * 60 * 1000)
const cycleAbortTimeoutMs = readPositiveInteger("AGENT_CYCLE_ABORT_TIMEOUT_MS", 5_000)
const maxCycles = once
  ? 1
  : readPositiveInteger("AGENT_MAX_CYCLES", Number.MAX_SAFE_INTEGER)
const port = readPositiveInteger("OPENCODE_SERVER_PORT", 4096)
const terminalLogFormat = resolveTerminalLogFormat(
  readSetting("AGENT_LOG_FORMAT"),
)
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
const optionUniverseProvider = createAlpacaOptionUniverseProvider({
  apiKey: alpacaApiKey,
  secretKey: alpacaSecretKey,
  dataBaseUrl:
    readSetting("ALPACA_MARKET_DATA_BASE_URL")?.trim() ||
    "https://data.alpaca.markets",
  tradingBaseUrl:
    readSetting("ALPACA_TRADING_BASE_URL")?.trim() ||
    "https://paper-api.alpaca.markets",
})
const riskStateProvider = createAlpacaRiskStateProvider({
  apiKey: alpacaApiKey,
  secretKey: alpacaSecretKey,
  dataBaseUrl:
    readSetting("ALPACA_MARKET_DATA_BASE_URL")?.trim() ||
    "https://data.alpaca.markets",
  tradingBaseUrl:
    readSetting("ALPACA_TRADING_BASE_URL")?.trim() ||
    "https://paper-api.alpaca.markets",
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
const researchCompatibility =
  RESEARCH_INVOCATION_PROVENANCE_BY_VERSION[RESEARCH_INVOCATION_VERSION]
const traceVersions = {
  agentName: researchCompatibility.agentName,
  cycleMode: researchMode === undefined ? "STANDARD" : "DRY_RUN",
  promptVersion: researchCompatibility.promptVersion,
  decisionContractVersion: researchCompatibility.decisionContractVersion,
  reportVersion: researchCompatibility.reportVersion,
} as const
mkdirSync(dirname(ledgerPath), { recursive: true })
const workerInstanceLock = acquireWorkerInstanceLock({ ledgerPath })
let ledgerStore: ReturnType<typeof createSqliteLedgerStore> | undefined
let telemetry: ReturnType<typeof startResearchTelemetry> | undefined
try {
  const activeLedgerStore = createSqliteLedgerStore({
    path: ledgerPath,
    knownCredentialValues,
  })
  ledgerStore = activeLedgerStore
  const activeTelemetry = startResearchTelemetry({
    disabled: readSetting("OTEL_SDK_DISABLED"),
    tracesEndpoint: readSetting("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
    endpoint: readSetting("OTEL_EXPORTER_OTLP_ENDPOINT"),
    tracesHeaders: readSetting("OTEL_EXPORTER_OTLP_TRACES_HEADERS"),
    headers: readSetting("OTEL_EXPORTER_OTLP_HEADERS"),
    tracesTimeoutMs: readSetting("OTEL_EXPORTER_OTLP_TRACES_TIMEOUT"),
    timeoutMs: readSetting("OTEL_EXPORTER_OTLP_TIMEOUT"),
  })
  telemetry = activeTelemetry

  await activeLedgerStore.migrate(abortController.signal)
  const lifecycleRecorder = createResearchLifecycleRecorder({
    store: activeLedgerStore,
  })
  const breakerState = await lifecycleRecorder.loadResearchLoopBreakerState()
  if (breakerState.latched) {
    throw new WorkerFatalError(
      `Research loop breaker is latched after ${breakerState.consecutiveFailures} consecutive failures; ${breakerResetInstruction}`,
    )
  }
  let researchContext = await reconstructResearchContextV1(activeLedgerStore)
  const shadowRiskEvaluator = createShadowRiskEvaluator({
    provider: riskStateProvider,
    durableControl: createLedgerDurableRiskControlStateLoader(activeLedgerStore),
  })
  const runtime = await startOpencode({
    port,
    signal: abortController.signal,
    timeoutMs: serverTimeout,
  })

  try {
    const cycleNumbers = new Map<number, number>()
    await runAgentLoop({
      intervalMs,
      maxBackoffMs,
      maxConsecutiveFailures,
      maxCycles,
      signal: abortController.signal,
      runCycle: async (attempt) => activeTelemetry.runCycle(
        attempt,
        traceVersions,
        async (cycleTrace) => {
        const { initialEligibility, session } = await cycleTrace.run(
          "research.eligibility",
          async () => {
            const eligibilityEvaluatedAt = new Date()
            const calendarSignal = cycleTimeoutMs === undefined
              ? abortController.signal
              : AbortSignal.any([
                  abortController.signal,
                  AbortSignal.timeout(cycleTimeoutMs),
                ])
            const requestedSessionDate =
              agentOptions.sessionDate ?? newYorkDate(eligibilityEvaluatedAt)
            const session = await calendar.getSession(
              requestedSessionDate,
              calendarSignal,
              dryRun && agentOptions.sessionDate === undefined,
            )
            return {
              session,
              initialEligibility: evaluateResearchEligibility({
                evaluatedAt: eligibilityEvaluatedAt,
                ...(session === undefined ? {} : { session }),
                premarketStartEt,
                ...(researchMode === undefined ? {} : { researchMode }),
              }),
            }
          },
        )
        const getEligibility = () =>
          evaluateResearchEligibility({
            evaluatedAt: new Date(),
            ...(session === undefined ? {} : { session }),
            premarketStartEt,
            tradeIntentWindow: initialEligibility.tradeIntentWindow ?? null,
            ...(researchMode === undefined ? {} : { researchMode }),
          })
        if (!initialEligibility.researchEligible) {
          const reason = initialEligibility.reason ?? "RESEARCH_WINDOW_INELIGIBLE"
          cycleTrace.setOutcome("SKIPPED", reason)
          return `Research cycle skipped: ${reason}`
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
            researchContext = await loadResearchContextV1(activeLedgerStore)
          } catch (error) {
            throw new LedgerPersistenceError("context query", error)
          }
          const cycleNumber = researchContext.nextCycleNumber
          cycleNumbers.set(attempt, cycleNumber)
          cycle = await lifecycleRecorder.startCycle({
            sessionId,
            cycleNumber,
            sessionDate,
            initialEligibility,
            signal: abortController.signal,
          })
        } catch (error) {
          abortController.abort(error)
          throw error
        }
        const cycleNumber = cycle.cycleNumber
        const stageReporter = createTerminalStageReporter({
          cycleId: cycle.cycleId,
          cycleNumber,
          startedAt: cycle.startedAt,
          format: terminalLogFormat,
        })
        stageReporter.report("runtime.session", "COMPLETED", {
          sessionId,
          url: runtime.url,
        })
        stageReporter.report("eligibility", "COMPLETED", {
          sessionDate,
          researchEligible: initialEligibility.researchEligible,
          tradeIntentEligible: initialEligibility.tradeIntentEligible,
          mode: initialEligibility.researchMode ?? "STANDARD",
          reason: initialEligibility.reason ?? null,
          slotStartedAt:
            initialEligibility.tradeIntentWindow?.slotStartedAt ?? null,
          deadline: initialEligibility.tradeIntentWindow?.deadline ?? null,
        })
        stageReporter.report("research.agent", "STARTED", {
          agent: researchCompatibility.agentName,
          promptVersion: researchCompatibility.promptVersion,
        })
        cycleTrace.identify({
          cycleId: cycle.cycleId,
          cycleNumber,
          sessionId,
        })

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
        let researchInvocation: ResearchInvocationV1 | undefined
        let timedOut = false

        try {
          const processed = await runWithCycleDeadline({
            ...(cycleTimeoutMs === undefined ? {} : { timeoutMs: cycleTimeoutMs }),
            shutdownSignal: abortController.signal,
            run: async (signal) => {
              stageReporter.report("universe.discover", "STARTED")
              const optionUniverse = await cycleTrace.run(
                "market.option_universe.discover",
                () => optionUniverseProvider.discover(sessionDate, signal),
              )
              stageReporter.report("universe.discover", "COMPLETED", {
                snapshotId: optionUniverse.snapshotId,
                candidates: optionUniverse.candidates.map(
                  ({ underlying }) => underlying,
                ),
              })
              const symbolScreen = screenOptionUniverseV2(optionUniverse)
              stageReporter.report("universe.screen", "COMPLETED", {
                policyVersion: symbolScreen.policyVersion,
                actionableUnderlyings: symbolScreen.symbols.flatMap((symbol) =>
                  symbol.strategies.some(
                      ({ actionability }) => actionability === "ACTIONABLE",
                    )
                    ? [symbol.underlying]
                    : [],
                ),
              })
              const response = await cycleTrace.run(
                "opencode.session.prompt",
                async () => {
                  const prompt = async (
                    text: string,
                    enabledTools: Record<string, boolean> = tools,
                  ) => {
                    const response = await runtime.client.session.prompt({
                      path: { id: sessionId },
                      signal,
                      body: {
                        agent: researchCompatibility.agentName,
                        tools: enabledTools,
                        parts: [{ type: "text", text }],
                      },
                    })
                    if (!response.data) {
                      throw formatApiError(
                        "Prompting OpenCode session",
                        response.error,
                      )
                    }
                    const identity = assertResearchModelIdentityV1(
                      summarizeOpenCodeInvocation(
                        response.data.info,
                        response.data.parts,
                      ),
                    )
                    if (!identity.ok) {
                      stageReporter.report("research.agent", "REJECTED", {
                        reason: identity.reason,
                        expected: identity.expected,
                        observed: identity.observed,
                      })
                      await cycle.recordInvocationIdentityRejected(
                        {
                          reason: identity.reason,
                          expected: identity.expected,
                          observed: identity.observed,
                        },
                        signal,
                      )
                      throw new Error(
                        `Research model identity rejected: ${identity.reason} (expected ${identity.expected}, observed ${identity.observed})`,
                      )
                    }
                    return response.data
                  }
                  const textResponse = (parts: readonly { type: string; text?: string }[]) =>
                    parts
                      .flatMap((part) =>
                        part.type === "text" && typeof part.text === "string"
                          ? [part.text.trim()]
                          : [],
                      )
                      .filter(Boolean)
                      .join("\n")

                  const initialResponse = await prompt(
                    buildResearchCyclePrompt(
                      cycleNumber,
                      new Date(cycle.startedAt),
                      optionUniverse,
                      task,
                      researchContext,
                      initialEligibility,
                      symbolScreen,
                    ),
                  )
                  const resolvedResponse = await repairResearchReportV7ResponseOnce(
                    textResponse(initialResponse.parts),
                    async (issues) => {
                      const availableTools = await runtime.client.tool.ids({ signal })
                      if (!availableTools.data || availableTools.data.length === 0) {
                        throw formatApiError(
                          "Listing OpenCode tools for schema repair",
                          availableTools.error,
                        )
                      }
                      const repairResponse = await prompt(
                        buildResearchReportRepairPrompt(issues),
                        Object.fromEntries(
                          availableTools.data.map((tool) => [tool, false]),
                        ),
                      )
                      if (repairResponse.parts.some(({ type }) => type === "tool")) {
                        throw new Error("Schema repair cannot call tools")
                      }
                      return textResponse(repairResponse.parts)
                    },
                  )
                  const text = resolvedResponse.rawResponse
                  const schemaRepairAttempted =
                    resolvedResponse.schemaRepairAttempted

                  const messages = await runtime.client.session.messages({
                    path: { id: sessionId },
                  })
                  if (!messages.data) {
                    throw formatApiError(
                      "Reading OpenCode session messages",
                      messages.error,
                    )
                  }
                  const cycleStartedAt = Date.parse(cycle.startedAt)
                  const cycleMessages = messages.data.filter(
                    ({ info }) => info.time.created >= cycleStartedAt,
                  )
                  const invocationParts = cycleMessages.flatMap(({ parts }) => parts)
                  const assistantMessages = cycleMessages.flatMap(({ info }) =>
                    info.role === "assistant" ? [info] : [],
                  )
                  const invocation = summarizeOpenCodeInvocation(
                    assistantMessages,
                    invocationParts,
                  )
                  const aggregateIdentity = assertResearchModelIdentityV1(invocation)
                  if (!aggregateIdentity.ok) {
                    stageReporter.report("research.agent", "REJECTED", {
                      reason: aggregateIdentity.reason,
                      expected: aggregateIdentity.expected,
                      observed: aggregateIdentity.observed,
                    })
                    await cycle.recordInvocationIdentityRejected(
                      {
                        reason: aggregateIdentity.reason,
                        expected: aggregateIdentity.expected,
                        observed: aggregateIdentity.observed,
                      },
                      signal,
                    )
                    throw new Error(
                      `Research model identity rejected: ${aggregateIdentity.reason} (expected ${aggregateIdentity.expected}, observed ${aggregateIdentity.observed})`,
                    )
                  }
                  cycleTrace.recordOpenCodeResult(invocation)
                  const budgetViolation = researchToolBudgetViolation(invocation)
                  if (budgetViolation !== undefined) {
                    stageReporter.report("research.agent", "REJECTED", {
                      reason: budgetViolation,
                      toolCallCount: invocation.toolCallCount,
                    })
                    throw new Error(
                      `Research tool budget rejected: ${budgetViolation}`,
                    )
                  }
                  stageReporter.report("research.agent", "COMPLETED", {
                    providerId: invocation.providerId,
                    modelId: invocation.modelId,
                    inputTokenCount: invocation.inputTokenCount ?? null,
                    outputTokenCount: invocation.outputTokenCount ?? null,
                    reasoningTokenCount:
                      invocation.reasoningTokenCount ?? null,
                    toolCallCount: invocation.toolCallCount,
                    toolErrorCount: invocation.toolErrorCount,
                    toolCalls: invocation.toolCalls.map(
                      ({ name, outcome }) => `${name}:${outcome}`,
                    ),
                    schemaRepairAttempted,
                  })
                  return { text, invocation, schemaRepairAttempted }
                },
              )

              researchInvocation = createResearchInvocationV1(
                traceVersions,
                response.invocation,
                { schemaRepairAttempted: response.schemaRepairAttempted },
              )
              return processResearchCycle({
                rawResponse: response.text,
                cycleStartedAt: cycle.startedAt,
                optionUniverse,
                symbolScreen,
                signal,
                quoteProvider,
                shadowRiskEvaluator,
                outcomeSink: cycle.outcomeSink,
                getEligibility,
                researchInvocation,
                trace: cycleTrace,
                stageReporter,
              })
            },
            onTimeout: async () => {
              timedOut = true
              cycleTrace.setOutcome("TIMEOUT")
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
          cycleTrace.setOutcome(processed.outcome.status)
          try {
            const artifacts = await cycleTrace.run(
              "research.artifact.project",
              async () => {
                const run = await loadResearchRunV1(
                  activeLedgerStore,
                  cycle.cycleId,
                )
                stageReporter.report("research.evaluate", "STARTED")
                const presentation = buildResearchRunPresentation(run)
                stageReporter.report(
                  "research.evaluate",
                  presentation.audit.failCount === 0 ? "COMPLETED" : "REJECTED",
                  {
                    passCount: presentation.audit.passCount,
                    failCount: presentation.audit.failCount,
                    notApplicableCount:
                      presentation.audit.notApplicableCount,
                    issues: presentation.audit.issueCodes,
                    actionability: presentation.actionability,
                  },
                )
                stageReporter.report("artifact.write", "STARTED")
                return writeResearchRunArtifacts({ run, presentation })
              },
            )
            stageReporter.report("artifact.write", "COMPLETED", {
              path: artifacts.markdownPath,
              markdownPath: artifacts.markdownPath,
              jsonPath: artifacts.jsonPath,
            })
            return [
              processed.report,
              `Actionability: ${artifacts.presentation.actionability}`,
              `Audit: ${artifacts.presentation.audit.passCount} PASS / ${artifacts.presentation.audit.failCount} FAIL / ${artifacts.presentation.audit.notApplicableCount} N/A`,
              `Research brief: ${artifacts.markdownPath}`,
              `Canonical JSON: ${artifacts.jsonPath}`,
            ].join("\n")
          } catch {
            stageReporter.report("artifact.write", "REJECTED", {
              reason: "WRITE_FAILED",
            })
            console.error(
              `[cycle ${cycleNumber}] validated outcome recorded, but research artifact could not be written`,
            )
            return `${processed.report}\nResearch artifacts: unavailable`
          }
        } catch (error) {
          if (error instanceof LedgerPersistenceError) {
            cycleTrace.setOutcome("FAILED")
            abortController.abort(error)
          } else if (abortController.signal.aborted) {
            cycleTrace.setOutcome(timedOut ? "TIMEOUT" : "SHUTDOWN")
            await interruptCycle(timedOut ? "TIMEOUT" : "SHUTDOWN")
          } else if (!timedOut) {
            cycleTrace.setOutcome("FAILED")
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
      }),
      onResult: (result, attempt) => {
        if (terminalLogFormat === "json") return
        console.log(`[cycle ${cycleNumbers.get(attempt) ?? attempt}]\n${result}`)
      },
      onError: (error, attempt) =>
        console.error(
          `[cycle ${cycleNumbers.get(attempt) ?? attempt}] failed`,
          error,
        ),
      isFatalError: (error) =>
        error instanceof LedgerPersistenceError ||
        error instanceof WorkerFatalError,
      onBreakerLatched: ({ attempt, consecutiveFailures, threshold }) =>
        lifecycleRecorder.recordResearchLoopBreakerLatched({
          lastAttempt: attempt,
          consecutiveFailures,
          threshold,
        }),
    })
  } catch (error) {
    if (error instanceof AgentLoopBreakerLatchedError) {
      throw new WorkerFatalError(
        `${error.message}; ${breakerResetInstruction}`,
        error,
      )
    }
    throw error
  } finally {
    await runtime.close()
  }
} finally {
  try {
    await ledgerStore?.close()
  } finally {
    try {
      await telemetry?.shutdown()
    } finally {
      workerInstanceLock.release()
    }
  }
}
