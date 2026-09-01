import {
  proposalQuoteSnapshotRef,
} from "../../contracts/research-decision-v3.js"
import {
  RESEARCH_DECISION_V4_CONTRACT_VERSION,
  validateResearchDecisionV4,
  type TradeProposalV4,
} from "../../contracts/research-decision-v4.js"
import type { ResearchReportV7 } from "../../contracts/research-report-v7.js"
import type {
  TradeIntentDerivationContextV4,
  TradeIntentDerivationResultV4,
} from "../../contracts/trade-intent-v4.js"
import type { OptionQuoteProvider } from "../../market-data/alpaca-option-quotes.js"
import type { ResearchCycleTrace } from "../../observability/research-telemetry.js"
import type { TerminalStageReporter } from "../../observability/terminal-stage-reporter.js"
import type { ShadowRiskEvaluator } from "../../risk/shadow-risk-service.js"
import {
  newYorkLocalTime,
  type ResearchEligibilityV1,
} from "../../scheduling/research-eligibility.js"
import {
  strategyActionabilityIssuePathV2,
  type SymbolScreenResultV2,
} from "../symbol-screen.js"
import {
  RESEARCH_CYCLE_OUTCOME_VERSION,
  type ResearchCycleEvidenceSnapshotReferenceV1,
  type ResearchProposalDispositionV2,
} from "./outcome.js"
import type { ResearchCycleStageReports } from "./stage-reporting.js"
import type { ResearchCycleTerminalResolution } from "./terminal.js"

const MAX_PROPOSAL_MARKET_REGIME_AGE_MS = 60_000
const MAX_PROPOSAL_ACCOUNT_CHECK_AGE_MS = 5 * 60_000
export const MAX_SELECTED_SHADOW_PROPOSALS = 1

const preflightSnapshot = {
  provider: "ALPACA",
  source: "proposal-evidence-preflight",
  retrievedAt: "2000-01-01T00:00:00.000Z",
  freshUntil: "2000-01-01T00:00:00.000Z",
} as const

const preflightContextFor = (proposals: readonly TradeProposalV4[]) => ({
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

export type ProposedPortfolioReportV4 = Readonly<
  Omit<ResearchReportV7, "result"> & {
    result: Extract<ResearchReportV7["result"], { outcome: "PROPOSE_TRADES" }>
  }
>

export const isProposedPortfolioReport = (
  report: ResearchReportV7,
): report is ProposedPortfolioReportV4 =>
  report.result.outcome === "PROPOSE_TRADES"

const marketRegimeFor = (
  report: ResearchReportV7,
  proposal: TradeProposalV4,
) => report.analysis.marketRegimes.find(
  ({ underlying }) => underlying === proposal.candidate.underlying,
)

const candidateEvaluationFor = (
  report: ResearchReportV7,
  proposal: TradeProposalV4,
) => report.analysis.candidateEvaluations.find(
  ({ underlying }) => underlying === proposal.candidate.underlying,
)

const proposalSymbolEvaluationIssuePath = (
  report: ProposedPortfolioReportV4,
  proposal: TradeProposalV4,
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
  report: ResearchReportV7,
  proposal: TradeProposalV4,
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
  report: ResearchReportV7,
  evaluatedAt: string,
) => observationIsFresh(
  report.analysis.accountChecks.observedAt,
  evaluatedAt,
  MAX_PROPOSAL_ACCOUNT_CHECK_AGE_MS,
)

export const proposalHistoryIssuePath = (
  report: ProposedPortfolioReportV4,
  proposal: TradeProposalV4,
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
  proposal: TradeProposalV4,
  context: TradeIntentDerivationContextV4,
) => TradeIntentDerivationResultV4

export type ProcessResearchProposalPathOptions = Readonly<{
  report: ProposedPortfolioReportV4
  symbolScreen: SymbolScreenResultV2
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
  proposal: TradeProposalV4,
  context: Parameters<typeof validateResearchDecisionV4>[1],
) => validateResearchDecisionV4(
  {
    contractVersion: RESEARCH_DECISION_V4_CONTRACT_VERSION,
    outcome: "PROPOSE_TRADES",
    proposals: [{ ...proposal, priority: 1 }],
  },
  context,
)

const identityFor = (proposal: TradeProposalV4) => ({
  priority: proposal.priority,
  underlying: proposal.candidate.underlying,
})

async function processOneProposal(
  options: ProcessResearchProposalPathOptions,
  proposal: TradeProposalV4,
): Promise<Readonly<{
  disposition: ResearchProposalDispositionV2
  evidenceSnapshots: readonly ResearchCycleEvidenceSnapshotReferenceV1[]
}>> {
  const {
    report,
    symbolScreen,
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
  const actionabilityIssue = strategyActionabilityIssuePathV2(
    symbolScreen,
    proposal.candidate.underlying,
    proposal.candidate.strategy,
  )
  if (actionabilityIssue !== undefined) {
    return {
      disposition: {
        ...identity,
        status: "DECISION_REJECTED",
        issues: [{ code: "CONTEXT_INVALID", path: actionabilityIssue }],
      },
      evidenceSnapshots: [],
    }
  }
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
      contractSymbols: proposal.candidate.legs.map(({ contractSymbol }) =>
        contractSymbol
      ),
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
      quotes: quoteConfirmation.snapshot.quotes,
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

const executionQualityFor = (disposition: ResearchProposalDispositionV2) => {
  if (
    disposition.status !== "RISK_EVALUATED" ||
    disposition.shadowRisk.decision.stage !== "EVALUATED" ||
    disposition.shadowRisk.decision.outcome !== "APPROVED"
  ) return undefined

  const intent = disposition.intent
  return {
    disposition,
    combinedQuoteWidthCents: intent.legs.reduce(
      (total, leg) => total + leg.ratioQuantity *
        (leg.quote.askCentsPerShare - leg.quote.bidCentsPerShare),
      0,
    ),
    entryLimitCents: intent.entryLimitCentsPerStrategyUnit,
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

  return left.disposition.priority - right.disposition.priority ||
    left.disposition.underlying.localeCompare(right.disposition.underlying)
}

/** Processes all ranked proposals, then deterministically selects within capacity. */
export async function processResearchProposalPath(
  options: ProcessResearchProposalPathOptions,
): Promise<ResearchCycleTerminalResolution> {
  const preflight = await options.trace.run("research.decision.validate", () =>
    validateResearchDecisionV4(
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
