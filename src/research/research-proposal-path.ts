import {
  RESEARCH_DECISION_CONTRACT_VERSION,
  proposalQuoteSnapshotRef,
  validateResearchDecisionV3,
  type TradeProposalV3,
} from "../contracts/research-decision-v3.js"
import type { ResearchReportV6 } from "../contracts/research-report-v6.js"
import type {
  TradeIntentDerivationContextV3,
  TradeIntentDerivationResultV3,
} from "../contracts/trade-intent-v3.js"
import type { OptionQuoteProvider } from "../market-data/alpaca-option-quotes.js"
import type { ResearchCycleTrace } from "../observability/research-telemetry.js"
import type { TerminalStageReporter } from "../observability/terminal-stage-reporter.js"
import type { ShadowRiskEvaluator } from "../risk/shadow-risk-service.js"
import {
  newYorkLocalTime,
  type ResearchEligibilityV1,
} from "../scheduling/research-eligibility.js"
import {
  RESEARCH_CYCLE_OUTCOME_VERSION,
  type ResearchCycleEvidenceSnapshotReferenceV1,
  type ResearchProposalDispositionV1,
} from "./research-cycle-outcome-v3.js"
import type { ResearchCycleStageReports } from "./research-cycle-stage-reporting.js"
import type { ResearchCycleTerminalResolution } from "./research-cycle-terminal.js"

const MAX_PROPOSAL_MARKET_REGIME_AGE_MS = 60_000
const MAX_PROPOSAL_ACCOUNT_CHECK_AGE_MS = 5 * 60_000
export const MAX_SELECTED_SHADOW_PROPOSALS = 1

const preflightSnapshot = {
  provider: "ALPACA",
  source: "proposal-evidence-preflight",
  retrievedAt: "2000-01-01T00:00:00.000Z",
  freshUntil: "2000-01-01T00:00:00.000Z",
} as const

const preflightContextFor = (proposals: readonly TradeProposalV3[]) => ({
  evaluatedAt: "2000-01-01T00:00:00.000Z",
  snapshots: Object.fromEntries(
    proposals.map(({ candidate }) => [
      proposalQuoteSnapshotRef(candidate.underlying),
      preflightSnapshot,
    ]),
  ),
})

export const PROPOSAL_EVIDENCE_PREFLIGHT_CONTEXT = preflightContextFor([])

const observationIsFresh = (
  observedAt: string,
  evaluatedAt: string,
  maximumAgeMs: number,
) => {
  const evaluationTime = Date.parse(evaluatedAt)
  const observationTime = Date.parse(observedAt)
  const age = evaluationTime - observationTime
  return (
    Number.isFinite(evaluationTime) &&
    Number.isFinite(observationTime) &&
    age >= 0 &&
    age <= maximumAgeMs
  )
}

export type ProposedPortfolioReportV3 = Readonly<
  Omit<ResearchReportV6, "result"> & {
    result: Extract<ResearchReportV6["result"], { outcome: "PROPOSE_TRADES" }>
  }
>

export const isProposedPortfolioReport = (
  report: ResearchReportV6,
): report is ProposedPortfolioReportV3 =>
  report.result.outcome === "PROPOSE_TRADES"

const marketRegimeFor = (
  report: ResearchReportV6,
  proposal: TradeProposalV3,
) => report.analysis.marketRegimes.find(
  ({ underlying }) => underlying === proposal.candidate.underlying,
)

const candidateEvaluationFor = (
  report: ResearchReportV6,
  proposal: TradeProposalV3,
) => report.analysis.candidateEvaluations.find(
  ({ underlying }) => underlying === proposal.candidate.underlying,
)

const proposalSymbolEvaluationIssuePath = (
  report: ProposedPortfolioReportV3,
  proposal: TradeProposalV3,
): readonly (string | number)[] | undefined => {
  const evaluationIndex = report.analysis.symbolEvaluations.findIndex(
    ({ underlying }) => underlying === proposal.candidate.underlying,
  )
  const evaluation = report.analysis.symbolEvaluations[evaluationIndex]
  if (evaluation?.disposition !== "PROPOSE") {
    return evaluationIndex < 0
      ? ["analysis", "symbolEvaluations"]
      : ["analysis", "symbolEvaluations", evaluationIndex]
  }
  return evaluation.direction === proposal.direction
    ? undefined
    : ["analysis", "symbolEvaluations", evaluationIndex, "direction"]
}

export const proposalMarketRegimeIsFresh = (
  report: ResearchReportV6,
  proposal: TradeProposalV3,
  evaluatedAt: string,
) => {
  const regime = marketRegimeFor(report, proposal)
  return regime !== undefined && observationIsFresh(
    regime.observedAt,
    evaluatedAt,
    MAX_PROPOSAL_MARKET_REGIME_AGE_MS,
  )
}

export const proposalAccountChecksAreFresh = (
  report: ResearchReportV6,
  evaluatedAt: string,
) => observationIsFresh(
  report.analysis.accountChecks.observedAt,
  evaluatedAt,
  MAX_PROPOSAL_ACCOUNT_CHECK_AGE_MS,
)

export const proposalHistoryIssuePath = (
  report: ProposedPortfolioReportV3,
  proposal: TradeProposalV3,
  eligibility: ResearchEligibilityV1,
): readonly (string | number)[] | undefined => {
  const sessionDate = eligibility.sessionDate
  const regimeIndex = report.analysis.marketRegimes.findIndex(
    ({ underlying }) => underlying === proposal.candidate.underlying,
  )
  const regime = report.analysis.marketRegimes[regimeIndex]
  if (sessionDate === undefined || regime === undefined) {
    return ["analysis", "marketRegimes"]
  }

  const observedAt = Date.parse(regime.observedAt)
  const sessionOpen = newYorkLocalTime(sessionDate, "09:30").getTime()
  const expectedIntradayBars = Math.floor((observedAt - sessionOpen) / 60_000)
  if (
    !Number.isFinite(observedAt) ||
    expectedIntradayBars <= 0 ||
    regime.intradayBarCount !== expectedIntradayBars
  ) {
    return ["analysis", "marketRegimes", regimeIndex, "intradayBarCount"]
  }

  const evaluationIndex = report.analysis.candidateEvaluations.findIndex(
    ({ underlying }) => underlying === proposal.candidate.underlying,
  )
  const evaluation = report.analysis.candidateEvaluations[evaluationIndex]
  if (evaluation === undefined) return ["analysis", "candidateEvaluations"]
  const sessionDay = Date.parse(`${sessionDate}T00:00:00.000Z`)
  const expirationDay = Date.parse(
    `${proposal.candidate.expiration}T00:00:00.000Z`,
  )
  const expectedDte = (expirationDay - sessionDay) / 86_400_000
  if (!Number.isInteger(expectedDte) || evaluation.dte !== expectedDte) {
    return ["analysis", "candidateEvaluations", evaluationIndex, "dte"]
  }

  const previousSessionDates = eligibility.previousSessionDates
  if (previousSessionDates === undefined || previousSessionDates.length < 2) {
    return ["analysis", "candidateEvaluations", evaluationIndex, "legs", 0, "openInterestDate"]
  }
  const indicatorCutoffIssue = report.analysis.symbolIndicators?.findIndex(
    ({ throughSessionDate }) => throughSessionDate !== previousSessionDates.at(-1),
  ) ?? -1
  if (report.analysis.symbolIndicators === undefined) {
    return ["analysis", "symbolIndicators"]
  }
  if (indicatorCutoffIssue >= 0) {
    return ["analysis", "symbolIndicators", indicatorCutoffIssue, "throughSessionDate"]
  }

  const eligibleOpenInterestDates = new Set([
    sessionDate,
    ...previousSessionDates.slice(-2),
  ])
  const staleOpenInterestIndex = evaluation.legs.findIndex(
    ({ openInterestDate }) => !eligibleOpenInterestDates.has(openInterestDate),
  )
  return staleOpenInterestIndex < 0
    ? undefined
    : [
        "analysis",
        "candidateEvaluations",
        evaluationIndex,
        "legs",
        staleOpenInterestIndex,
        "openInterestDate",
      ]
}

export type ProposalIntentDeriver = (
  proposal: TradeProposalV3,
  context: TradeIntentDerivationContextV3,
) => TradeIntentDerivationResultV3

export type ProcessResearchProposalPathOptions = Readonly<{
  report: ProposedPortfolioReportV3
  signal: AbortSignal
  quoteProvider: OptionQuoteProvider
  shadowRiskEvaluator: ShadowRiskEvaluator
  getEligibility: () => ResearchEligibilityV1
  deriveIntent: ProposalIntentDeriver
  trace: ResearchCycleTrace
  stages: ResearchCycleStageReports
  stageReporter: TerminalStageReporter
}>

const validateOneProposal = (
  proposal: TradeProposalV3,
  context: Parameters<typeof validateResearchDecisionV3>[1],
) => validateResearchDecisionV3(
  {
    contractVersion: RESEARCH_DECISION_CONTRACT_VERSION,
    outcome: "PROPOSE_TRADES",
    proposals: [{ ...proposal, priority: 1 }],
  },
  context,
)

const identityFor = (proposal: TradeProposalV3) => ({
  priority: proposal.priority,
  underlying: proposal.candidate.underlying,
})

async function processOneProposal(
  options: ProcessResearchProposalPathOptions,
  proposal: TradeProposalV3,
): Promise<Readonly<{
  disposition: ResearchProposalDispositionV1
  evidenceSnapshots: readonly ResearchCycleEvidenceSnapshotReferenceV1[]
}>> {
  const {
    report,
    signal,
    quoteProvider,
    shadowRiskEvaluator,
    getEligibility,
    deriveIntent,
    trace,
    stages,
    stageReporter,
  } = options
  const identity = identityFor(proposal)
  const proposalEligibility = getEligibility()
  if (!proposalEligibility.tradeIntentEligible) {
    return {
      disposition: {
        ...identity,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["MARKET_WINDOW_INELIGIBLE"],
      },
      evidenceSnapshots: [],
    }
  }

  const contextIssue = proposalSymbolEvaluationIssuePath(report, proposal) ??
    (!proposalMarketRegimeIsFresh(
        report,
        proposal,
        proposalEligibility.evaluatedAt,
      )
      ? ["analysis", "marketRegimes"] as const
      : !proposalAccountChecksAreFresh(report, proposalEligibility.evaluatedAt)
        ? ["analysis", "accountChecks", "observedAt"] as const
        : proposalHistoryIssuePath(report, proposal, proposalEligibility))
  if (contextIssue !== undefined) {
    return {
      disposition: {
        ...identity,
        status: "DECISION_REJECTED",
        issues: [{ code: "CONTEXT_INVALID", path: contextIssue }],
      },
      evidenceSnapshots: [],
    }
  }

  signal.throwIfAborted()
  const quoteConfirmation = await trace.run("market.option_quotes.confirm", () =>
    quoteProvider.confirmQuotes({
      longContractSymbol: proposal.candidate.longLeg.contractSymbol,
      shortContractSymbol: proposal.candidate.shortLeg.contractSymbol,
      signal,
    }),
  )
  signal.throwIfAborted()
  if (!quoteConfirmation.success) {
    stages.quotesRejected(quoteConfirmation.reasons)
    return {
      disposition: {
        ...identity,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: quoteConfirmation.reasons,
      },
      evidenceSnapshots: [],
    }
  }
  stages.quotesConfirmed(quoteConfirmation.snapshot)

  const snapshotRef = proposalQuoteSnapshotRef(proposal.candidate.underlying)
  const evidenceSnapshots: readonly ResearchCycleEvidenceSnapshotReferenceV1[] = [{
    snapshotRef,
    ...quoteConfirmation.snapshot.snapshotMetadata,
    temporalClass: "LIVE",
  }]
  if (
    !proposalMarketRegimeIsFresh(
      report,
      proposal,
      quoteConfirmation.snapshot.evaluatedAt,
    ) ||
    !proposalAccountChecksAreFresh(
      report,
      quoteConfirmation.snapshot.evaluatedAt,
    )
  ) {
    return {
      disposition: {
        ...identity,
        status: "DECISION_REJECTED",
        issues: [{ code: "CONTEXT_INVALID", path: ["analysis"] }],
      },
      evidenceSnapshots,
    }
  }
  if (!getEligibility().tradeIntentEligible) {
    return {
      disposition: {
        ...identity,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["MARKET_WINDOW_INELIGIBLE"],
      },
      evidenceSnapshots,
    }
  }

  const validation = await trace.run("research.decision.validate", () =>
    validateOneProposal(proposal, {
      evaluatedAt: quoteConfirmation.snapshot.evaluatedAt,
      snapshots: {
        [snapshotRef]: quoteConfirmation.snapshot.snapshotMetadata,
      },
    }),
  )
  if (!validation.success) {
    return {
      disposition: {
        ...identity,
        status: "DECISION_REJECTED",
        issues: validation.issues,
      },
      evidenceSnapshots,
    }
  }

  const derivation = await trace.run("research.intent.derive", () =>
    deriveIntent(proposal, {
      quoteSnapshotRef: snapshotRef,
      evaluatedAt: quoteConfirmation.snapshot.evaluatedAt,
      longQuote: quoteConfirmation.snapshot.longQuote,
      shortQuote: quoteConfirmation.snapshot.shortQuote,
    }),
  )
  if (!derivation.success) {
    stages.intentRejected(derivation.reasons)
    return {
      disposition: {
        ...identity,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: derivation.reasons,
      },
      evidenceSnapshots,
    }
  }
  stages.intentDerived(derivation.intent)

  if (
    proposalEligibility.sessionDate === undefined ||
    proposalEligibility.tradeIntentWindow === undefined
  ) {
    return {
      disposition: {
        ...identity,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["MARKET_WINDOW_INELIGIBLE"],
      },
      evidenceSnapshots,
    }
  }
  const shadowRisk = await trace.run("risk.shadow.evaluate", () =>
    shadowRiskEvaluator.evaluate({
      decision: proposal,
      sourceIntent: derivation.intent,
      captureEligibility: {
        ...proposalEligibility,
        sessionDate: proposalEligibility.sessionDate!,
        tradeIntentWindow: proposalEligibility.tradeIntentWindow!,
      },
      getEvaluationEligibility: getEligibility,
      signal,
      stageReporter,
    }),
  )
  stages.riskEvaluated(shadowRisk)
  return {
    disposition: {
      ...identity,
      status: "RISK_EVALUATED",
      proposal,
      intent: derivation.intent,
      shadowRisk,
      selected: false,
    },
    evidenceSnapshots,
  }
}

const compareFractions = (
  leftNumerator: number,
  leftDenominator: number,
  rightNumerator: number,
  rightDenominator: number,
) => {
  const left = BigInt(leftNumerator) * BigInt(rightDenominator)
  const right = BigInt(rightNumerator) * BigInt(leftDenominator)
  return left < right ? -1 : left > right ? 1 : 0
}

const executionQualityFor = (disposition: ResearchProposalDispositionV1) => {
  if (
    disposition.status !== "RISK_EVALUATED" ||
    disposition.shadowRisk.decision.stage !== "EVALUATED" ||
    disposition.shadowRisk.decision.outcome !== "APPROVED"
  ) return undefined

  const intent = disposition.shadowRisk.decision.evaluatedIntent
  return {
    disposition,
    combinedQuoteWidthCents:
      intent.longQuote.askCentsPerShare - intent.longQuote.bidCentsPerShare +
      intent.shortQuote.askCentsPerShare - intent.shortQuote.bidCentsPerShare,
    entryLimitCents: intent.entryLimitCentsPerShare,
    spreadWidthCents: intent.widthCentsPerShare,
  }
}

const compareExecutionQuality = (
  left: NonNullable<ReturnType<typeof executionQualityFor>>,
  right: NonNullable<ReturnType<typeof executionQualityFor>>,
) => {
  const quoteWidthComparison = compareFractions(
    left.combinedQuoteWidthCents,
    left.entryLimitCents,
    right.combinedQuoteWidthCents,
    right.entryLimitCents,
  )
  if (quoteWidthComparison !== 0) return quoteWidthComparison

  const debitComparison = compareFractions(
    left.entryLimitCents,
    left.spreadWidthCents,
    right.entryLimitCents,
    right.spreadWidthCents,
  )
  if (debitComparison !== 0) return debitComparison

  return left.disposition.priority - right.disposition.priority ||
    left.disposition.underlying.localeCompare(right.disposition.underlying)
}

/** Processes all ranked proposals, then deterministically selects within capacity. */
export async function processResearchProposalPath(
  options: ProcessResearchProposalPathOptions,
): Promise<ResearchCycleTerminalResolution> {
  const preflight = await options.trace.run("research.decision.validate", () =>
    validateResearchDecisionV3(
      options.report.result,
      preflightContextFor(options.report.result.proposals),
    ),
  )
  if (!preflight.success) {
    return {
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: preflight.issues,
      },
    }
  }
  options.stages.decisionValidated(preflight.data)

  const processed = []
  for (const proposal of options.report.result.proposals) {
    processed.push(await processOneProposal(options, proposal))
  }

  const selectedDispositions = new Set(
    processed
      .flatMap(({ disposition }) => {
        const quality = executionQualityFor(disposition)
        return quality === undefined ? [] : [quality]
      })
      .sort(compareExecutionQuality)
      .slice(0, MAX_SELECTED_SHADOW_PROPOSALS)
      .map(({ disposition }) => disposition),
  )
  const dispositions = processed.map(({ disposition }) => {
    if (
      disposition.status !== "RISK_EVALUATED" ||
      !selectedDispositions.has(disposition)
    ) return disposition
    return { ...disposition, selected: true }
  })

  return {
    outcome: {
      outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
      status: "PORTFOLIO_EVALUATED",
      decision: options.report.result,
      proposals: dispositions,
    },
    metadata: {
      validatedDecision: options.report.result,
      evidenceSnapshots: processed.flatMap(({ evidenceSnapshots }) =>
        evidenceSnapshots
      ),
    },
  }
}
