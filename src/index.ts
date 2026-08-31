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
import { createAlpacaCalendarClient } from "./market-data/alpaca-calendar-client.js"
import { createAlpacaResearchSnapshotProvider } from "./market-data/alpaca-research-snapshot-provider-v1.js"
import { summarizeOpenCodeInvocation } from "./observability/opencode-telemetry-summary.js"
import { startResearchTelemetry } from "./observability/research-telemetry.js"
import {
  createTerminalStageReporter,
  resolveTerminalLogFormat,
} from "./observability/terminal-stage-reporter.js"
import {
  createAgentResearchScreeningModelDriftAuditV1,
  createAgentResearchScreeningUnavailableAuditV1,
  createApplicationCaptureUnavailableAuditV1,
  createResearchScreeningAuditV1,
  projectResearchReportV2ForScreeningAudit,
} from "./contracts/research-screening-audit-v1.js"
import {
  assertResearchModelIdentityV1,
  createResearchInvocationV1,
  RESEARCH_INVOCATION_VERSION,
  type ResearchInvocationV1,
} from "./research/research-invocation-v1.js"
import { startOpencode } from "./opencode-runtime.js"
import { buildResearchCyclePrompt } from "./research/research-agent.js"
import { loadResearchRunV1 } from "./research/research-artifact.js"
import {
  buildResearchRunPresentation,
  writeResearchRunArtifacts,
} from "./research/research-run-presentation.js"
import {
  loadResearchContextV1,
  reconstructResearchContextV1,
} from "./research/research-context-v1.js"
import { processResearchCycle } from "./research/research-cycle.js"
import {
  researchScreeningAuditWindowV1,
  runApplicationResearchScreeningAuditV1,
} from "./research/research-screening-audit-runtime-v1.js"
import { createAlpacaRiskStateProvider } from "./risk/alpaca-risk-state-provider.js"
import {
  createLedgerDurableRiskControlStateLoader,
  createShadowRiskEvaluator,
} from "./risk/shadow-risk-service.js"
import { CURRENT_STRATEGY_MANIFEST } from "./strategy/strategy-registry.js"
import {
  DEFAULT_PREMARKET_RESEARCH_START_ET,
  DRY_RUN_ANYTIME_RESEARCH_MODE,
  DRY_RUN_ANYTIME_SHADOW_MODE,
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
const { once, researchAnytime, shadowAnytime, ledgerPath } = agentOptions
const breakerResetInstruction =
  `run pnpm agent:reset-breaker -- --ledger <ledger-path> for ${JSON.stringify(ledgerPath)}`
const researchMode = researchAnytime
  ? DRY_RUN_ANYTIME_RESEARCH_MODE
  : shadowAnytime
    ? DRY_RUN_ANYTIME_SHADOW_MODE
    : undefined
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
const cycleTimeoutMs = readPositiveInteger("AGENT_CYCLE_TIMEOUT_MS", 5 * 60 * 1000)
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
const researchSnapshotProvider = createAlpacaResearchSnapshotProvider({
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
  CURRENT_STRATEGY_MANIFEST.researchPlanCompatibility
const traceVersions = {
  agentName: researchCompatibility.agentName,
  cycleMode: researchMode ?? "STANDARD",
  promptVersion: researchCompatibility.promptVersion,
  skillName: researchCompatibility.skillName,
  skillVersion: researchCompatibility.skillVersion,
  strategyVersion: CURRENT_STRATEGY_MANIFEST.strategyVersion,
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
            const calendarSignal = AbortSignal.any([
              abortController.signal,
              AbortSignal.timeout(cycleTimeoutMs),
            ])
            const session = await calendar.getSession(
              newYorkDate(eligibilityEvaluatedAt),
              calendarSignal,
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
          skillVersion: researchCompatibility.skillVersion,
          strategyVersion: CURRENT_STRATEGY_MANIFEST.strategyVersion,
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
        const auditWindow = researchScreeningAuditWindowV1(initialEligibility)
        const applicationAudit = auditWindow === undefined
          ? undefined
          : (() => {
              const controller = new AbortController()
              return {
                controller,
                result: runApplicationResearchScreeningAuditV1({
                  provider: researchSnapshotProvider,
                  sessionDate,
                  slotStartedAt: auditWindow.slotStartedAt,
                  signal: AbortSignal.any([
                    controller.signal,
                    abortController.signal,
                    AbortSignal.timeout(cycleTimeoutMs),
                  ]),
                }).catch(() => createApplicationCaptureUnavailableAuditV1(
                  ["UNEXPECTED_FAILURE"],
                  0,
                )),
              }
            })()
        let agentAudit = createAgentResearchScreeningUnavailableAuditV1(
          "INVOCATION_FAILED",
        )
        let researchInvocation: ResearchInvocationV1 | undefined
        const recordScreeningAudit = async (cancelApplication: boolean) => {
          if (applicationAudit === undefined) return
          if (cancelApplication && !applicationAudit.controller.signal.aborted) {
            applicationAudit.controller.abort(
              new DOMException("Research screening audit cancelled", "AbortError"),
            )
          }
          try {
            await lifecycleRecorder.recordResearchScreeningAudit(
              cycle.cycleId,
              createResearchScreeningAuditV1({
                application: await applicationAudit.result,
                agent: agentAudit,
              }),
              AbortSignal.timeout(cycleAbortTimeoutMs),
            )
          } catch {
            console.error(
              `[cycle ${cycleNumber}] research screening audit unavailable`,
            )
          }
        }
        let timedOut = false

        try {
          const processed = await runWithCycleDeadline({
            timeoutMs: cycleTimeoutMs,
            shutdownSignal: abortController.signal,
            run: async (signal) => {
              const response = await cycleTrace.run(
                "opencode.session.prompt",
                async () => {
                  const response = await runtime.client.session.prompt({
                    path: { id: sessionId },
                    signal,
                    body: {
                      agent: researchCompatibility.agentName,
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
                    throw formatApiError(
                      "Prompting OpenCode session",
                      response.error,
                    )
                  }
                  const invocation = summarizeOpenCodeInvocation(
                    response.data.info,
                    response.data.parts,
                  )
                  cycleTrace.recordOpenCodeResult(invocation)
                  // Assert the pinned model before any of this response is
                  // parsed. Compares the raw summary, not the durable
                  // projection, which rewrites unsafe labels to "unknown".
                  const identity = assertResearchModelIdentityV1(invocation)
                  if (!identity.ok) {
                    stageReporter.report("research.agent", "REJECTED", {
                      reason: identity.reason,
                      expected: identity.expected,
                      observed: identity.observed,
                    })
                    try {
                      agentAudit = createAgentResearchScreeningModelDriftAuditV1({
                        invocationVersion: RESEARCH_INVOCATION_VERSION,
                        reason: identity.reason,
                        expected: identity.expected,
                        observed: identity.observed,
                      })
                    } catch {
                      agentAudit = createAgentResearchScreeningUnavailableAuditV1(
                        "UNEXPECTED_FAILURE",
                      )
                    }
                    await cycle.recordInvocationIdentityRejected(
                      {
                        reason: identity.reason,
                        expected: identity.expected,
                        observed: identity.observed,
                      },
                      signal,
                    )
                    // Non-fatal: this counts toward the consecutive-failure
                    // breaker, so a sustained provider swap halts the worker
                    // rather than looping.
                    throw new Error(
                      `Research model identity rejected: ${identity.reason} (expected ${identity.expected}, observed ${identity.observed})`,
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
                  })
                  return { response, invocation }
                },
              )

              const text = response.response.data.parts
                .filter((part) => part.type === "text")
                .map((part) => part.text.trim())
                .filter(Boolean)
                .join("\n")

              researchInvocation = createResearchInvocationV1(
                traceVersions,
                response.invocation,
              )
              return processResearchCycle({
                rawResponse: text,
                cycleStartedAt: cycle.startedAt,
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
            agentAudit = processed.researchReport === undefined ||
                researchInvocation === undefined
              ? createAgentResearchScreeningUnavailableAuditV1(
                  "REPORT_REJECTED",
                )
              : projectResearchReportV2ForScreeningAudit(
                  processed.researchReport,
                  researchInvocation,
                )
          } catch {
            agentAudit = createAgentResearchScreeningUnavailableAuditV1(
              "UNEXPECTED_FAILURE",
            )
          }
          await recordScreeningAudit(false)
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
            if (agentAudit.status === "UNAVAILABLE") {
              agentAudit = createAgentResearchScreeningUnavailableAuditV1(
                "AUDIT_CANCELLED",
              )
            }
            await recordScreeningAudit(true)
          } else if (!timedOut) {
            cycleTrace.setOutcome("FAILED")
            const abortFailure = await synchronizeSessionAbort(
              "Aborting failed OpenCode session",
            )
            await interruptCycle("FAILED")
            if (
              researchInvocation !== undefined &&
              agentAudit.status === "UNAVAILABLE" &&
              agentAudit.reason === "INVOCATION_FAILED"
            ) {
              agentAudit = createAgentResearchScreeningUnavailableAuditV1(
                "UNEXPECTED_FAILURE",
              )
            }
            await recordScreeningAudit(true)
            if (abortFailure) {
              const fatal = new WorkerFatalError(
                abortFailure.message,
                abortFailure,
              )
              abortController.abort(fatal)
              throw fatal
            }
          } else {
            if (agentAudit.status === "UNAVAILABLE") {
              agentAudit = createAgentResearchScreeningUnavailableAuditV1(
                "AUDIT_CANCELLED",
              )
            }
            await recordScreeningAudit(true)
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
