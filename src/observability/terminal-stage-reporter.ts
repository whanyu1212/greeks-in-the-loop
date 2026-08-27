import pc from "picocolors"

export type TerminalLogFormat = "pretty" | "json"

export type TerminalStageStatus =
  | "STARTED"
  | "COMPLETED"
  | "REJECTED"
  | "SKIPPED"

export type TerminalStageValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]

export type TerminalStageReporter = Readonly<{
  report(
    stage: string,
    status: TerminalStageStatus,
    details?: Readonly<Record<string, TerminalStageValue>>,
  ): void
}>

export const NOOP_TERMINAL_STAGE_REPORTER: TerminalStageReporter = {
  report: () => undefined,
}

export function resolveTerminalLogFormat(
  configured: string | undefined,
  isTTY = process.stdout.isTTY === true,
): TerminalLogFormat {
  const value = configured?.trim().toLowerCase()
  if (value === undefined || value === "") return isTTY ? "pretty" : "json"
  if (value === "pretty" || value === "json") return value
  throw new Error("AGENT_LOG_FORMAT must be pretty or json")
}

const elapsed = (milliseconds: number) => {
  if (milliseconds < 1_000) return `${milliseconds} ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.floor((milliseconds % 60_000) / 1_000)
  return `${minutes}m ${seconds}s`
}

const stageLabel = (stage: string) =>
  ({
    "runtime.session": "Runtime session",
    eligibility: "Eligibility",
    "research.agent": "Research agent",
    "research.report": "Research report",
    "preliminary.validate": "Preliminary validation",
    "decision.validate": "Decision validation",
    "quotes.confirm": "Quote confirmation",
    "intent.derive": "Intent derivation",
    "risk.durable_state": "Risk control state",
    "risk.state_capture": "Risk state capture",
    "risk.intent_refresh": "Risk intent refresh",
    "risk.evaluate": "Risk evaluation",
    "ledger.commit": "Ledger commit",
    "cycle.outcome": "Cycle outcome",
    "artifact.write": "Artifact",
  })[stage] ?? stage

const detail = (
  details: Readonly<Record<string, TerminalStageValue>>,
  key: string,
) => details[key]

const reasonSummary = (details: Readonly<Record<string, TerminalStageValue>>) => {
  for (const key of ["reasonCodes", "issues", "reconciliationReasonCodes"]) {
    const value = detail(details, key)
    if (Array.isArray(value) && value.length > 0) return value.join(", ")
  }
  return undefined
}

const prettySummary = (
  stage: string,
  details: Readonly<Record<string, TerminalStageValue>>,
) => {
  const reasons = reasonSummary(details)
  if (reasons !== undefined) return reasons
  switch (stage) {
    case "runtime.session":
      return `${String(detail(details, "sessionId"))} | ${String(detail(details, "url"))}`
    case "eligibility":
      return [
        detail(details, "tradeIntentEligible") === true
          ? "trade eligible"
          : "research only",
        detail(details, "mode"),
        detail(details, "deadline") === null
          ? undefined
          : `deadline ${String(detail(details, "deadline"))}`,
      ].filter(Boolean).join(" | ")
    case "research.agent": {
      const model = detail(details, "modelId")
      if (model === undefined) {
        return [
          detail(details, "agent"),
          `strategy ${String(detail(details, "strategyVersion"))}`,
        ].filter(Boolean).join(" | ")
      }
      return [
        model,
        `${String(detail(details, "inputTokenCount") ?? "?")} in / ${String(detail(details, "outputTokenCount") ?? "?")} out`,
        `${String(detail(details, "toolCallCount") ?? 0)} tools`,
      ].join(" | ")
    }
    case "research.report":
      return `${String(detail(details, "resultOutcome"))} | strategy ${String(detail(details, "strategyVersion"))} | ${String(detail(details, "externalSourceCount"))} external sources`
    case "decision.validate":
      return [
        detail(details, "outcome"),
        detail(details, "direction"),
        detail(details, "structure"),
      ].filter(Boolean).join(" | ")
    case "preliminary.validate":
      return `${String(detail(details, "direction"))} | ${String(detail(details, "evidenceCount"))} evidence claims`
    case "quotes.confirm":
      return `${String(detail(details, "longContractSymbol"))} / ${String(detail(details, "shortContractSymbol"))}`
    case "intent.derive":
      return `${String(detail(details, "structure"))} | expires ${String(detail(details, "expiration"))} | max loss ${String(detail(details, "maxLossCentsPerContract"))}c`
    case "risk.durable_state":
      return `daily breaker ${String(detail(details, "dailyBreakerActive"))} | competition breaker ${String(detail(details, "competitionBreakerActive"))}`
    case "risk.state_capture":
      return `captured ${String(detail(details, "evaluatedAt"))}`
    case "risk.intent_refresh":
      return `limit ${String(detail(details, "entryLimitCentsPerShare"))}c | max loss ${String(detail(details, "maxLossCentsPerContract"))}c`
    case "risk.evaluate":
      return `${String(detail(details, "evaluationStage"))} | ${String(detail(details, "outcome"))}`
    case "ledger.commit":
      return `${String(detail(details, "outcomeStatus"))} | ${String(detail(details, "evidenceSnapshotCount"))} snapshots`
    case "cycle.outcome":
      return String(detail(details, "outcomeStatus"))
    case "artifact.write":
      return String(detail(details, "path") ?? detail(details, "reason") ?? "")
    default:
      return ""
  }
}

const statusSymbol = (status: TerminalStageStatus) => {
  switch (status) {
    case "STARTED":
      return pc.cyan("●")
    case "COMPLETED":
      return pc.green("✓")
    case "REJECTED":
      return pc.red("✗")
    case "SKIPPED":
      return pc.yellow("○")
  }
}

const prettyLine = (
  timestamp: string,
  elapsedMs: number,
  stage: string,
  status: TerminalStageStatus,
  details: Readonly<Record<string, TerminalStageValue>>,
) => {
  const time = pc.dim(timestamp.slice(11, 19))
  const label = stageLabel(stage).padEnd(23)
  const duration = pc.dim(elapsed(elapsedMs).padStart(8))
  const summary = prettySummary(stage, details)
  return `${time}  ${statusSymbol(status)}  ${pc.bold(label)} ${duration}${summary ? `  ${summary}` : ""}`
}

export function createTerminalStageReporter(options: Readonly<{
  cycleId: string
  cycleNumber: number
  startedAt: string
  format?: TerminalLogFormat
  write?: (line: string) => void
  now?: () => Date
}>): TerminalStageReporter {
  const write = options.write ?? console.log
  const now = options.now ?? (() => new Date())
  const startedAt = Date.parse(options.startedAt)
  const format = options.format ?? resolveTerminalLogFormat(undefined)
  return {
    report(stage, status, details = {}) {
      const timestamp = now().toISOString()
      const elapsedMs = Math.max(0, Date.parse(timestamp) - startedAt)
      if (format === "pretty") {
        write(prettyLine(timestamp, elapsedMs, stage, status, details))
        return
      }
      write(JSON.stringify({
        ...details,
        timestamp,
        cycleId: options.cycleId,
        cycleNumber: options.cycleNumber,
        elapsedMs,
        stage,
        status,
      }))
    },
  }
}
