import { mkdir, mkdtemp, open, rename, rm, unlink } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"

import {
  evaluateResearchRunV1,
  type ResearchRunEvaluationV1,
} from "../../evaluation/research-run-evaluation.js"
import {
  DEFAULT_RESEARCH_ARTIFACT_ROOT,
  writeResearchRunArtifact,
  type ResearchRunV1,
} from "./artifact.js"
import { deriveVerticalSpreadGreeksV1 } from "../../shared/vertical-spread-greeks.js"

export type ResearchRunActionability =
  | "NO_ACTION"
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
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/([\\`*_[\]<>|])/gu, "\\$1")

const markdownValue = (value: string | number | boolean) =>
  markdownText(String(value))

const externalUrl = (value: string) =>
  value.replace(/>/gu, "%3E").replace(/</gu, "%3C")

const dollarsFromCents = (value: number) => `$${(value / 100).toFixed(2)}`
const dollarsFromHalfCents = (value: number) => `$${(value / 200).toFixed(3)}`
const percentFromRatio = (value: number) => `${(value * 100).toFixed(2)}%`

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
    case "DECISION_REJECTED":
      return "REJECTED"
    case "PORTFOLIO_EVALUATED":
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
    case "PORTFOLIO_EVALUATED":
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
    "> Derived operator view. The event ledger is authoritative and the canonical JSON is the portable machine record. No order was submitted.",
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
  const result = run.researchReport?.result ?? run.validatedDecision
  if (result === undefined) {
    lines.push("No schema-valid research result was retained.", "")
  } else if (result.outcome === "NO_ACTION") {
    lines.push(`**Result:** NO_ACTION`, "")
    bullets(lines, "Reason Codes", result.reasonCodes)
  } else {
    lines.push(`**Result:** ${result.outcome}`, "")
    for (const proposal of result.proposals) {
      lines.push(
        `**${proposal.priority}. ${proposal.candidate.underlying} / ${proposal.direction}:** ${markdownText(proposal.thesis)}`,
        "",
      )
      bullets(lines, "Invalidation", proposal.invalidation)
    }
  }
  bullets(lines, "Terminal Reasons", outcomeReasons(run))

  const report = run.researchReport
  if (report !== undefined) {
    const account = report.analysis.accountChecks
    const market = report.analysis.marketRegimes[0]
    lines.push("## Market And Account Context", "")
    table(lines, [
      ["Analysis as of", report.analysis.asOf],
      ["Account observed", account.observedAt],
      ["Account status", account.accountStatus],
      ["Options approved", account.optionsTradingApproved],
      ["Conflicting exposure", account.conflictingStrategyExposure],
      ...(market === undefined
        ? []
        : [
            ["Market observed", market.observedAt] as const,
            ["Temporal class", market.temporalClass] as const,
            ["Signal", market.signal] as const,
          ]),
      ...(market?.dailyClose === undefined
        ? []
        : [["Daily close", market.dailyClose] as const]),
      ...(market?.sma20 === undefined ? [] : [["SMA 20", market.sma20] as const]),
      ...(market?.sma50 === undefined ? [] : [["SMA 50", market.sma50] as const]),
      ...(market?.sessionVwap === undefined
        ? []
        : [["Session VWAP", market.sessionVwap] as const]),
      ...(market?.spotMidpoint === undefined
        ? []
        : [["Spot midpoint", market.spotMidpoint] as const]),
      ...(market === undefined
        ? []
        : [
            ["Daily sessions", market.dailySessionCount] as const,
            ["Intraday bars", market.intradayBarCount] as const,
          ]),
    ])
    if (report.analysis.symbolIndicators !== undefined) {
      lines.push("## Universe Indicator Context", "")
      table(lines, report.analysis.symbolIndicators.flatMap((indicator) => [
        [`${indicator.underlying} through`, indicator.throughSessionDate] as const,
        [`${indicator.underlying} 5-day return`, percentFromRatio(indicator.return5d)] as const,
        [`${indicator.underlying} 20-day return`, percentFromRatio(indicator.return20d)] as const,
        [`${indicator.underlying} relative-strength rank`, indicator.relativeStrengthRank20d] as const,
        [`${indicator.underlying} realized volatility`, percentFromRatio(indicator.realizedVolatility20)] as const,
        [`${indicator.underlying} completed-session volume ratio`, `${indicator.completedSessionVolumeRatio20.toFixed(2)}x`] as const,
      ]))
    }
  }

  if (run.symbolScreen !== undefined) {
    lines.push("## Deterministic Symbol Screen", "")
    const screenRows: readonly (readonly [string, string])[] =
      run.symbolScreen.screenVersion === "1.0.0"
        ? run.symbolScreen.results.flatMap((result) => {
            const agentEvaluation = report?.analysis.symbolEvaluations.find(
              ({ underlying }) => underlying === result.underlying,
            )
            return [
              [`${result.underlying} actionability`, result.actionability],
              [`${result.underlying} direction`, result.direction],
              [`${result.underlying} structure`, result.structure ?? "NONE"],
              [
                `${result.underlying} reasons`,
                result.reasonCodes.length === 0
                  ? "NONE"
                  : result.reasonCodes.join(", "),
              ],
              [
                `${result.underlying} agent disposition`,
                agentEvaluation?.disposition ?? "UNAVAILABLE",
              ],
              [
                `${result.underlying} agent direction`,
                agentEvaluation?.direction ?? "UNAVAILABLE",
              ],
            ] as const
          })
        : run.symbolScreen.symbols.flatMap((symbol) => {
            const agentEvaluation = report?.analysis.symbolEvaluations.find(
              ({ underlying }) => underlying === symbol.underlying,
            )
            return [
              ...symbol.strategies.map((assessment) => [
                `${symbol.underlying} ${assessment.strategy}`,
                assessment.reasonCodes.length === 0
                  ? assessment.actionability
                  : `${assessment.actionability}: ${assessment.reasonCodes.join(", ")}`,
              ] as const),
              [
                `${symbol.underlying} agent disposition`,
                agentEvaluation?.disposition ?? "UNAVAILABLE",
              ] as const,
              [
                `${symbol.underlying} agent direction`,
                agentEvaluation?.direction ?? "UNAVAILABLE",
              ] as const,
            ]
          })
    table(lines, [
      ["Mode", run.symbolScreen.mode],
      ["Policy version", run.symbolScreen.policyVersion],
      ["Evaluated", run.symbolScreen.evaluatedAt],
      ...screenRows,
    ])
  }

  const selectedUnderlying = run.outcome.status === "PORTFOLIO_EVALUATED"
    ? run.outcome.selectedUnderlyings[0]
    : undefined
  const primaryProposal = result?.outcome === "PROPOSE_TRADES"
    ? result.proposals.find(
        ({ candidate }) => candidate.underlying === selectedUnderlying,
      ) ?? result.proposals[0]
    : undefined
  const candidate = primaryProposal?.candidate
  if (candidate !== undefined) {
    lines.push("## Candidate", "")
    table(lines, "strategy" in candidate
      ? [
          ["Underlying", candidate.underlying],
          ["Strategy", candidate.strategy],
          ...candidate.legs.map((leg, index) => [
            `Leg ${index + 1}`,
            `${leg.positionIntent} ${leg.ratioQuantity} ${leg.contractSymbol}`,
          ] as const),
        ]
      : [
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

    const diagnostics = report?.analysis.candidateEvaluations.find(
      ({ underlying }) => underlying === candidate.underlying,
    )
    if (diagnostics !== undefined) {
      lines.push(`**Diagnostics observed:** ${diagnostics.observedAt}`, "")
      if ("dte" in diagnostics) {
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
            ...(leg.ivToRealizedVolatility === undefined
              ? []
              : [[`${leg.role} IV / realized volatility`, leg.ivToRealizedVolatility] as const]),
            ...(leg.bidAskSpreadPercent === undefined
              ? []
              : [[`${leg.role} bid-ask spread`, percentFromRatio(leg.bidAskSpreadPercent)] as const]),
          ]),
        ])
        const longLeg = diagnostics.legs.find(({ role }) => role === "LONG")
        const shortLeg = diagnostics.legs.find(({ role }) => role === "SHORT")
        const spreadGreeks = longLeg === undefined || shortLeg === undefined
          ? undefined
          : deriveVerticalSpreadGreeksV1(longLeg, shortLeg)
        if (spreadGreeks !== undefined) {
          lines.push("**Agent-reported spread Greeks (long minus short):**", "")
          table(lines, [
            ["Net delta", spreadGreeks.netDelta],
            ["Net gamma", spreadGreeks.netGamma],
            ["Net theta", spreadGreeks.netTheta],
            ["Net vega", spreadGreeks.netVega],
          ])
        }
      } else {
        table(lines, diagnostics.legs.flatMap((leg, index) => [
          [`Leg ${index + 1} intent`, leg.positionIntent] as const,
          [`Leg ${index + 1} ratio`, leg.ratioQuantity] as const,
          [`Leg ${index + 1} delta`, leg.delta] as const,
          [`Leg ${index + 1} implied volatility`, leg.impliedVolatility] as const,
          [`Leg ${index + 1} volume`, leg.volume] as const,
          [`Leg ${index + 1} open interest`, leg.openInterest] as const,
        ]))
        if (diagnostics.aggregateGreeks !== undefined) {
          lines.push("**Agent-reported position-weighted Greeks:**", "")
          table(lines, [
            ["Net delta", diagnostics.aggregateGreeks.netDelta],
            ["Net gamma", diagnostics.aggregateGreeks.netGamma],
            ["Net theta", diagnostics.aggregateGreeks.netTheta],
            ["Net vega", diagnostics.aggregateGreeks.netVega],
          ])
        }
      }
    }
  }

  if (run.outcome.status === "PORTFOLIO_EVALUATED" && run.outcome.intents[0]) {
    const primaryIntent = run.outcome.intents.find(
      ({ underlying }) => underlying === selectedUnderlying,
    ) ?? run.outcome.intents[0]
    const evaluatedRisk =
      run.shadowRisk?.decision.stage === "EVALUATED" &&
      run.shadowRisk.decision.evaluatedIntent.underlying ===
        primaryIntent.underlying
        ? run.shadowRisk.decision
        : undefined
    const intent = evaluatedRisk?.evaluatedIntent ?? primaryIntent
    lines.push("## Derived Intent", "")
    const basis = evaluatedRisk === undefined
      ? "INITIAL_DERIVATION"
      : "SHADOW_RISK_REFRESH"
    table(lines, "strategy" in intent
      ? [
          ["Basis", basis],
          ["Quote snapshot", intent.quoteSnapshotRef],
          ["Evaluated", intent.evaluatedAt],
          ["Strategy", intent.strategy],
          ["Premium effect", intent.premiumEffect],
          ["Entry limit", `${dollarsFromCents(intent.entryLimitCentsPerStrategyUnit)} per strategy unit`],
          ...intent.legs.flatMap((leg, index) => [
            [`Leg ${index + 1}`, `${leg.positionIntent} ${leg.ratioQuantity} ${leg.contractSymbol}`] as const,
            [`Leg ${index + 1} quote`, `${dollarsFromCents(leg.quote.bidCentsPerShare)} bid / ${dollarsFromCents(leg.quote.askCentsPerShare)} ask`] as const,
          ]),
        ]
      : [
          ["Basis", basis],
          ["Quote snapshot", intent.quoteSnapshotRef],
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

    const evidence = report.result.outcome === "NO_ACTION"
      ? report.result.evidence
      : report.result.proposals.flatMap(({ evidence }) => evidence)
    const claims = evidence.map((claim) => {
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
    const verifiedGreeks = risk.stage === "EVALUATED"
      ? risk.evaluation.aggregateGreeks ?? risk.evaluation.spreadGreeks
      : undefined
    const strategyEconomics = risk.stage === "EVALUATED"
      ? risk.evaluation.strategyEconomics
      : undefined
    lines.push("## Shadow Risk", "")
    table(lines, [
      ["Mode", risk.mode],
      ["Stage", risk.stage],
      ["Outcome", risk.outcome],
      ["Evaluated", riskEvaluatedAt ?? "unavailable"],
      ["Rule version", risk.ruleVersion],
      ...(verifiedGreeks === undefined
        ? []
        : [
            ["Verified net delta", verifiedGreeks.netDelta] as const,
            ["Verified net gamma", verifiedGreeks.netGamma] as const,
            ["Verified net theta", verifiedGreeks.netTheta] as const,
            ["Verified net vega", verifiedGreeks.netVega] as const,
          ]),
      ...(strategyEconomics === undefined
        ? []
        : [
            ["Entry premium", dollarsFromCents(strategyEconomics.entryPremiumCents)] as const,
            ["Maximum loss", dollarsFromCents(strategyEconomics.maxLossCents)] as const,
            ["Maximum profit", strategyEconomics.maxProfitCents === null
              ? "unbounded"
              : dollarsFromCents(strategyEconomics.maxProfitCents)] as const,
            ["Buying-power requirement", dollarsFromCents(strategyEconomics.buyingPowerRequirementCents)] as const,
            ["Collateral", strategyEconomics.collateral] as const,
          ]),
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

const writeMarkdown = async (
  path: string,
  markdown: string,
  overwrite: boolean,
) => {
  const handle = await open(path, overwrite ? "w" : "wx", 0o600)
  try {
    await handle.chmod(0o600)
    await handle.writeFile(markdown, "utf8")
    await handle.close()
  } catch (error) {
    await handle.close().catch(() => undefined)
    if (!overwrite) {
      await unlink(path).catch(() => undefined)
    }
    throw error
  }
}

const moveExistingToBackup = async (path: string, backupPath: string) => {
  try {
    await rename(path, backupPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

const replaceResearchRunArtifacts = async (
  run: ResearchRunV1,
  root: string,
  presentation: ResearchRunPresentation,
): Promise<ResearchRunArtifactBundle> => {
  await mkdir(root, { recursive: true })
  const stagingRoot = await mkdtemp(join(root, ".research-artifacts-"))
  let removeStaging = true
  try {
    const stagedJsonPath = await writeResearchRunArtifact({
      run,
      root: stagingRoot,
    })
    const stagedMarkdownPath = `${stagedJsonPath.slice(0, -".json".length)}.md`
    await writeMarkdown(stagedMarkdownPath, presentation.markdown, false)

    const jsonPath = join(root, relative(stagingRoot, stagedJsonPath))
    const markdownPath = join(root, relative(stagingRoot, stagedMarkdownPath))
    await mkdir(dirname(jsonPath), { recursive: true })
    const jsonBackupPath = join(stagingRoot, `previous-${basename(jsonPath)}`)
    const markdownBackupPath = join(
      stagingRoot,
      `previous-${basename(markdownPath)}`,
    )
    let jsonBackedUp = false
    let markdownBackedUp = false
    let jsonInstalled = false
    let markdownInstalled = false
    try {
      jsonBackedUp = await moveExistingToBackup(jsonPath, jsonBackupPath)
      markdownBackedUp = await moveExistingToBackup(
        markdownPath,
        markdownBackupPath,
      )
      await rename(stagedJsonPath, jsonPath)
      jsonInstalled = true
      await rename(stagedMarkdownPath, markdownPath)
      markdownInstalled = true
    } catch (error) {
      const rollbackErrors: unknown[] = []
      const attemptRollback = async (operation: () => Promise<unknown>) => {
        try {
          await operation()
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      if (markdownInstalled) {
        await attemptRollback(() =>
          rm(markdownPath, { recursive: true, force: true }),
        )
      }
      if (jsonInstalled) {
        await attemptRollback(() =>
          rm(jsonPath, { recursive: true, force: true }),
        )
      }
      if (markdownBackedUp) {
        await attemptRollback(() => rename(markdownBackupPath, markdownPath))
      }
      if (jsonBackedUp) {
        await attemptRollback(() => rename(jsonBackupPath, jsonPath))
      }
      if (rollbackErrors.length > 0) {
        removeStaging = false
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Research artifact replacement failed; recovery files remain at ${stagingRoot}`,
        )
      }
      throw error
    }
    return { jsonPath, markdownPath, presentation }
  } finally {
    if (removeStaging) {
      await rm(stagingRoot, { recursive: true, force: true })
    }
  }
}

/** Writes the canonical JSON and its derived Markdown operator brief. */
export async function writeResearchRunArtifacts({
  run,
  root = DEFAULT_RESEARCH_ARTIFACT_ROOT,
  overwrite = false,
  presentation = buildResearchRunPresentation(run),
}: WriteResearchRunArtifactsOptions): Promise<ResearchRunArtifactBundle> {
  if (overwrite) {
    return replaceResearchRunArtifacts(run, root, presentation)
  }
  const jsonPath = await writeResearchRunArtifact({
    run,
    root,
  })
  const markdownPath = `${jsonPath.slice(0, -".json".length)}.md`
  try {
    await writeMarkdown(markdownPath, presentation.markdown, false)
  } catch (error) {
    await unlink(jsonPath).catch(() => undefined)
    throw error
  }
  return { jsonPath, markdownPath, presentation }
}
