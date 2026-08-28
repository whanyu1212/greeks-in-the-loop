import { open } from "node:fs/promises"

import {
  evaluateResearchRunV1,
  type ResearchRunEvaluationV1,
} from "../evaluation/research-run-evaluation-v1.js"
import {
  writeResearchRunArtifact,
  type ResearchRunV1,
} from "./research-artifact.js"

export type ResearchRunActionability =
  | "NO_ACTION"
  | "RESEARCH_ONLY_REFRESH_REQUIRED"
  | "REJECTED"
  | "NON_EXECUTING_INTENT"
  | "SHADOW_APPROVED_NON_EXECUTING"
  | "SHADOW_REJECTED"

export type ResearchRunAuditSummary = Readonly<{
  passCount: number
  failCount: number
  notApplicableCount: number
  issueCodes: readonly string[]
}>

export type ResearchRunPresentation = Readonly<{
  markdown: string
  actionability: ResearchRunActionability
  evaluation: ResearchRunEvaluationV1
  audit: ResearchRunAuditSummary
}>

export type WriteResearchRunArtifactsOptions = Readonly<{
  run: ResearchRunV1
  root?: string
  overwrite?: boolean
  presentation?: ResearchRunPresentation
}>

export type ResearchRunArtifactBundle = Readonly<{
  jsonPath: string
  markdownPath: string
  presentation: ResearchRunPresentation
}>

const markdownText = (value: string) =>
  value
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/([\\`*_[\]<>|])/gu, "\\$1")

const markdownValue = (value: string | number | boolean) =>
  markdownText(String(value))

const externalUrl = (value: string) =>
  value.replace(/>/gu, "%3E").replace(/</gu, "%3C")

const dollarsFromCents = (value: number) => `$${(value / 100).toFixed(2)}`
const dollarsFromHalfCents = (value: number) => `$${(value / 200).toFixed(3)}`

const duration = (startedAt: string, completedAt: string) => {
  const milliseconds = Date.parse(completedAt) - Date.parse(startedAt)
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "unknown"
  return `${(milliseconds / 1_000).toFixed(1)} seconds`
}

const table = (
  lines: string[],
  rows: readonly (readonly [string, string | number | boolean])[],
) => {
  lines.push("| Field | Value |", "| --- | --- |")
  for (const [label, value] of rows) {
    lines.push(`| ${markdownText(label)} | ${markdownValue(value)} |`)
  }
  lines.push("")
}

const bullets = (lines: string[], title: string, values: readonly string[]) => {
  if (values.length === 0) return
  lines.push(`### ${title}`, "")
  for (const value of values) lines.push(`- ${markdownText(value)}`)
  lines.push("")
}

const auditSummary = (
  evaluation: ResearchRunEvaluationV1,
): ResearchRunAuditSummary => {
  const dimensions = Object.values(evaluation.dimensions)
  return {
    passCount: dimensions.filter(({ status }) => status === "PASS").length,
    failCount: dimensions.filter(({ status }) => status === "FAIL").length,
    notApplicableCount: dimensions.filter(
      ({ status }) => status === "NOT_APPLICABLE",
    ).length,
    issueCodes: [
      ...new Set(dimensions.flatMap(({ issueCodes }) => issueCodes)),
    ].sort(),
  }
}

const actionabilityFor = (run: ResearchRunV1): ResearchRunActionability => {
  switch (run.outcome.status) {
    case "VALIDATED_NO_ACTION":
      return "NO_ACTION"
    case "PRELIMINARY_RESEARCH_RETAINED":
      return "RESEARCH_ONLY_REFRESH_REQUIRED"
    case "DECISION_REJECTED":
    case "INTENT_DERIVATION_REJECTED":
      return "REJECTED"
    case "INTENT_DERIVED":
      if (run.shadowRisk?.decision.outcome === "APPROVED") {
        return "SHADOW_APPROVED_NON_EXECUTING"
      }
      if (run.shadowRisk?.decision.outcome === "REJECTED") {
        return "SHADOW_REJECTED"
      }
      return "NON_EXECUTING_INTENT"
  }
}

const outcomeReasons = (run: ResearchRunV1) => {
  switch (run.outcome.status) {
    case "VALIDATED_NO_ACTION":
      return []
    case "DECISION_REJECTED":
      return run.outcome.issues.map((issue) => {
        const path = issue.path.length === 0 ? "root" : issue.path.join(".")
        const category = issue.schemaCategory === undefined
          ? ""
          : ` (${issue.schemaCategory})`
        return `${issue.code} at ${path}${category}`
      })
    case "INTENT_DERIVATION_REJECTED":
      return run.outcome.reasons
    case "PRELIMINARY_RESEARCH_RETAINED":
    case "INTENT_DERIVED":
      return []
  }
}

const evaluationLabel = (key: string) =>
  ({
    contractCompliance: "Contract compliance",
    temporalIntegrity: "Temporal integrity",
    grounding: "Grounding",
    candidateIdentity: "Candidate identity",
    failClosedBehavior: "Fail-closed behavior",
  })[key] ?? key

/** Builds the deterministic, non-authoritative operator view of a research run. */
export function buildResearchRunPresentation(
  run: ResearchRunV1,
): ResearchRunPresentation {
  const evaluation = evaluateResearchRunV1(run)
  const audit = auditSummary(evaluation)
  const actionability = actionabilityFor(run)
  const lines: string[] = [
    `# Research Cycle ${run.cycle.cycleNumber} - ${run.cycle.sessionDate}`,
    "",
    "> Derived operator view. SQLite is authoritative and the canonical JSON is the portable machine record. No order was submitted.",
    "",
    "## At a Glance",
    "",
  ]

  table(lines, [
    ["Outcome", run.outcome.status],
    ["Actionability", actionability],
    ["Cycle mode", run.initialEligibility?.researchMode ?? "STANDARD"],
    ["Started", run.cycle.startedAt],
    ["Completed", run.cycle.completedAt],
    ["Duration", duration(run.cycle.startedAt, run.cycle.completedAt)],
  ])

  lines.push("## Decision", "")
  const result = run.researchReport?.result ??
    run.preliminaryResearch ??
    run.validatedDecision
  if (result === undefined) {
    lines.push("No schema-valid research result was retained.", "")
  } else if (result.outcome === "NO_ACTION") {
    lines.push(`**Result:** NO_ACTION`, "")
    bullets(lines, "Reason Codes", result.reasonCodes)
  } else {
    lines.push(
      `**Result:** ${result.outcome}`,
      `**Direction:** ${result.direction}`,
      `**Thesis:** ${markdownText(result.thesis)}`,
      "",
    )
    if (result.outcome === "PRELIMINARY_RESEARCH") {
      lines.push(
        `**Target session:** ${result.targetSessionDate}`,
        `**Refresh required:** ${result.requiresRefresh ? "yes" : "no"}`,
        "",
      )
    }
    bullets(lines, "Invalidation", result.invalidation)
  }
  bullets(lines, "Terminal Reasons", outcomeReasons(run))

  const report = run.researchReport
  if (report !== undefined) {
    const account = report.analysis.accountChecks
    const market = report.analysis.marketRegime
    lines.push("## Market And Account Context", "")
    table(lines, [
      ["Analysis as of", report.analysis.asOf],
      ["Account observed", account.observedAt],
      ["Account status", account.accountStatus],
      ["Options approved", account.optionsTradingApproved],
      ["Conflicting exposure", account.conflictingStrategyExposure],
      ["Market observed", market.observedAt],
      ["Temporal class", market.temporalClass],
      ["Signal", market.signal],
      ...(market.dailyClose === undefined
        ? []
        : [["Daily close", market.dailyClose] as const]),
      ...(market.sma20 === undefined ? [] : [["SMA 20", market.sma20] as const]),
      ...(market.sma50 === undefined ? [] : [["SMA 50", market.sma50] as const]),
      ...(market.sessionVwap === undefined
        ? []
        : [["Session VWAP", market.sessionVwap] as const]),
      ...(market.spotMidpoint === undefined
        ? []
        : [["Spot midpoint", market.spotMidpoint] as const]),
      ["Daily sessions", market.dailySessionCount],
      ["Intraday bars", market.intradayBarCount],
    ])
  }

  const candidate = result?.outcome === "PRELIMINARY_RESEARCH" ||
      result?.outcome === "PROPOSE_TRADE"
    ? result.candidate
    : undefined
  if (candidate !== undefined) {
    lines.push("## Candidate", "")
    table(lines, [
      ["Underlying", candidate.underlying],
      ["Structure", candidate.structure],
      ["Expiration", candidate.expiration],
      [
        "Long leg",
        `${candidate.longLeg.contractSymbol} at ${candidate.longLeg.strike}`,
      ],
      [
        "Short leg",
        `${candidate.shortLeg.contractSymbol} at ${candidate.shortLeg.strike}`,
      ],
    ])

    const diagnostics = report?.analysis.candidateEvaluation
    if (diagnostics !== undefined) {
      lines.push(`**Diagnostics observed:** ${diagnostics.observedAt}`, "")
      table(lines, [
        ["DTE", diagnostics.dte],
        ...diagnostics.legs.flatMap((leg) => [
          [`${leg.role} delta`, leg.delta] as const,
          [`${leg.role} implied volatility`, leg.impliedVolatility] as const,
          [`${leg.role} gamma`, leg.gamma] as const,
          [`${leg.role} theta`, leg.theta] as const,
          [`${leg.role} vega`, leg.vega] as const,
          [`${leg.role} volume`, leg.volume] as const,
          [`${leg.role} open interest`, leg.openInterest] as const,
          [`${leg.role} open-interest date`, leg.openInterestDate] as const,
        ]),
      ])
    }
  }

  if (run.outcome.status === "INTENT_DERIVED") {
    const intent = run.outcome.intent
    lines.push("## Derived Intent", "")
    table(lines, [
      ["Evaluated", intent.evaluatedAt],
      ["Long quote", `${dollarsFromCents(intent.longQuote.bidCentsPerShare)} bid / ${dollarsFromCents(intent.longQuote.askCentsPerShare)} ask`],
      ["Short quote", `${dollarsFromCents(intent.shortQuote.bidCentsPerShare)} bid / ${dollarsFromCents(intent.shortQuote.askCentsPerShare)} ask`],
      ["Entry limit", `${dollarsFromCents(intent.entryLimitCentsPerShare)} per share`],
      ["Spread width", `${dollarsFromCents(intent.widthCentsPerShare)} per share`],
      ["Maximum loss", `${dollarsFromCents(intent.maxLossCentsPerContract)} per contract`],
      ["Maximum profit", `${dollarsFromCents(intent.maxProfitCentsPerContract)} per contract`],
      ["Stop-loss mark", `${dollarsFromHalfCents(intent.stopLossMarkHalfCentsPerShare)} per share`],
      ["Profit-target mark", `${dollarsFromHalfCents(intent.profitTargetMarkHalfCentsPerShare)} per share`],
    ])
  }

  if (report !== undefined) {
    lines.push("## Evidence", "")
    bullets(lines, "Supporting Factors", report.analysis.supportingFactors)
    bullets(lines, "Contradicting Factors", report.analysis.contradictingFactors)
    bullets(lines, "Conflicts", report.analysis.conflicts)

    const claims = report.result.evidence.map((claim) => {
      if (claim.kind === "INFERENCE") {
        return `${claim.claimId} [INFERENCE from ${claim.basedOn.join(", ")}]: ${claim.claim}`
      }
      if ("provider" in claim) {
        return `${claim.claimId} [${claim.provider} ${claim.temporalClass}, ${claim.observedAt}]: ${claim.claim}`
      }
      return `${claim.claimId} [snapshot ${claim.snapshotRef}]: ${claim.claim}`
    })
    bullets(lines, "Evidence Claims", claims)

    if (report.analysis.externalContext.length > 0) {
      lines.push("### External Sources", "")
      for (const source of report.analysis.externalContext) {
        if (source.provider === "EXA") {
          lines.push(
            `- **EXA / ${source.relevance}:** ${markdownText(source.title)} - <${externalUrl(source.url)}>`,
            `  - Retrieved: ${source.retrievedAt}`,
            `  - ${markdownText(source.summary)}`,
          )
        } else {
          lines.push(
            `- **FMP / ${source.relevance}:** ${markdownText(source.dataset)} (${source.observedAt})`,
            `  - Retrieved: ${source.retrievedAt}`,
            `  - ${markdownText(source.summary)}`,
          )
        }
      }
      lines.push("")
    }
  }

  if (run.shadowRisk !== undefined) {
    const risk = run.shadowRisk.decision
    const riskEvaluatedAt = risk.stage === "EVALUATED"
      ? risk.evaluation.evaluatedAt
      : risk.evaluatedAt
    const riskReasons = risk.stage === "STATE_CAPTURE_FAILED"
      ? risk.captureReasonCodes
      : risk.stage === "INTENT_REFRESH_FAILED"
        ? risk.derivationReasonCodes
        : risk.evaluation.outcome === "REJECTED"
          ? risk.evaluation.reasonCodes
          : []
    lines.push("## Shadow Risk", "")
    table(lines, [
      ["Mode", risk.mode],
      ["Stage", risk.stage],
      ["Outcome", risk.outcome],
      ["Evaluated", riskEvaluatedAt ?? "unavailable"],
      ["Rule version", risk.ruleVersion],
    ])
    bullets(lines, "Risk Reasons", riskReasons)
    bullets(
      lines,
      "Breaker Transitions",
      run.shadowRisk.breakerTransitions.map(
        (transition) =>
          `${transition.breaker} breaker latched for ${transition.tradingDate} at ${transition.observedAt}`,
      ),
    )
  }

  lines.push("## Offline Audit", "")
  table(
    lines,
    Object.entries(evaluation.dimensions).map(([key, dimension]) => [
      evaluationLabel(key),
      dimension.issueCodes.length === 0
        ? dimension.status
        : `${dimension.status}: ${dimension.issueCodes.join(", ")}`,
    ]),
  )
  table(lines, [
    ["Sourced facts", evaluation.metrics.sourcedFactCount],
    ["Inferences", evaluation.metrics.inferenceCount],
    ["Grounded inferences", evaluation.metrics.groundedInferenceCount],
    ["Snapshot references", evaluation.metrics.snapshotReferenceCount],
    ["Exa sources", evaluation.metrics.exaSourceCount],
    ["FMP sources", evaluation.metrics.fmpSourceCount],
  ])

  lines.push("## Provenance", "")
  const invocation = run.researchInvocation
  table(lines, [
    ["Run version", run.runVersion],
    ["Report version", report?.reportVersion ?? "unavailable"],
    ["Cycle ID", run.cycle.cycleId],
    ["Ledger sequence", `${run.ledger.firstSequence}-${run.ledger.lastSequence}`],
    ["Terminal event", run.ledger.terminalEventId],
    ...(invocation === undefined
      ? []
      : [
          ["Agent", invocation.agentName] as const,
          ["Prompt version", invocation.promptVersion] as const,
          ["Skill", `${invocation.skillName} ${invocation.skillVersion}`] as const,
          ["Strategy version", invocation.strategyVersion] as const,
          ["Provider / model", `${invocation.providerId} / ${invocation.modelId}`] as const,
          ["Tool calls", invocation.tools.totalCount] as const,
          ["Tool errors", invocation.tools.errorCount] as const,
        ]),
  ])

  return {
    markdown: `${lines.join("\n").trimEnd()}\n`,
    actionability,
    evaluation,
    audit,
  }
}

/** Writes the canonical JSON and its derived Markdown operator brief. */
export async function writeResearchRunArtifacts({
  run,
  root,
  overwrite = false,
  presentation = buildResearchRunPresentation(run),
}: WriteResearchRunArtifactsOptions): Promise<ResearchRunArtifactBundle> {
  const jsonPath = await writeResearchRunArtifact({
    run,
    ...(root === undefined ? {} : { root }),
    overwrite,
  })
  const markdownPath = `${jsonPath.slice(0, -".json".length)}.md`
  const handle = await open(markdownPath, overwrite ? "w" : "wx", 0o600)
  try {
    await handle.chmod(0o600)
    await handle.writeFile(presentation.markdown, "utf8")
  } finally {
    await handle.close()
  }
  return { jsonPath, markdownPath, presentation }
}
