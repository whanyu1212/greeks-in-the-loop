import {
  validateResearchDecisionV1,
  type ProposedTradeDecisionV1,
} from "../contracts/research-decision-v1.js"
import type { ResearchReportV2 } from "../contracts/research-report-v2.js"
import type {
  TradeIntentDerivationContext,
  TradeIntentDerivationResult,
} from "../contracts/trade-intent-v1.js"
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
  type ResearchCycleTerminalRecordV1,
} from "./research-cycle-outcome-v1.js"
import type { ResearchCycleStageReports } from "./research-cycle-stage-reporting.js"
import type { ResearchCycleTerminalResolution } from "./research-cycle-terminal.js"

export const PROPOSAL_QUOTE_SNAPSHOT_REF =
  "alpaca-proposal-quotes-v1" as const
const MAX_PROPOSAL_MARKET_REGIME_AGE_MS = 60_000
const MAX_PROPOSAL_ACCOUNT_CHECK_AGE_MS = 5 * 60_000

// This context validates proposal evidence topology and restricts every sourced
// fact to the application-owned quote alias before any provider request. Real
// quote timestamps replace it for the authoritative post-fetch validation.
export const PROPOSAL_EVIDENCE_PREFLIGHT_CONTEXT = {
  evaluatedAt: "2000-01-01T00:00:00.000Z",
  snapshots: {
    [PROPOSAL_QUOTE_SNAPSHOT_REF]: {
      provider: "ALPACA",
      source: "proposal-evidence-preflight",
      retrievedAt: "2000-01-01T00:00:00.000Z",
      freshUntil: "2000-01-01T00:00:00.000Z",
    },
  },
} as const

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

export const proposalMarketRegimeIsFresh = (
  report: ResearchReportV2,
  evaluatedAt: string,
) =>
  observationIsFresh(
    report.analysis.marketRegime.observedAt,
    evaluatedAt,
    MAX_PROPOSAL_MARKET_REGIME_AGE_MS,
  )

export const proposalAccountChecksAreFresh = (
  report: ResearchReportV2,
  evaluatedAt: string,
) =>
  observationIsFresh(
    report.analysis.accountChecks.observedAt,
    evaluatedAt,
    MAX_PROPOSAL_ACCOUNT_CHECK_AGE_MS,
  )

export const proposalHistoryIssuePath = (
  report: ResearchReportV2,
  eligibility: ResearchEligibilityV1,
): readonly (string | number)[] | undefined => {
  const sessionDate = eligibility.sessionDate
  if (sessionDate === undefined) return ["analysis", "marketRegime", "observedAt"]

  const observedAt = Date.parse(report.analysis.marketRegime.observedAt)
  const sessionOpen = newYorkLocalTime(sessionDate, "09:30").getTime()
  const expectedIntradayBars = Math.floor((observedAt - sessionOpen) / 60_000)
  if (
    !Number.isFinite(observedAt) ||
    expectedIntradayBars <= 0 ||
    report.analysis.marketRegime.intradayBarCount !== expectedIntradayBars
  ) {
    return ["analysis", "marketRegime", "intradayBarCount"]
  }

  if (report.analysis.candidateEvaluation === undefined) {
    return ["analysis", "candidateEvaluation"]
  }
  const sessionDay = Date.parse(`${sessionDate}T00:00:00.000Z`)
  const expirationDay = Date.parse(`${report.result.outcome === "PROPOSE_TRADE"
    ? report.result.candidate.expiration
    : sessionDate}T00:00:00.000Z`)
  const expectedDte = (expirationDay - sessionDay) / 86_400_000
  if (
    !Number.isInteger(expectedDte) ||
    report.analysis.candidateEvaluation.dte !== expectedDte
  ) {
    return ["analysis", "candidateEvaluation", "dte"]
  }
  const previousSessionDates = eligibility.previousSessionDates
  if (previousSessionDates === undefined || previousSessionDates.length < 2) {
    return ["analysis", "candidateEvaluation", "legs", 0, "openInterestDate"]
  }
  const eligibleOpenInterestDates = new Set([
    sessionDate,
    ...previousSessionDates.slice(-2),
  ])
  const staleOpenInterestIndex =
    report.analysis.candidateEvaluation.legs.findIndex(
      ({ openInterestDate }) => !eligibleOpenInterestDates.has(openInterestDate),
    )
  if (staleOpenInterestIndex >= 0) {
    return [
      "analysis",
      "candidateEvaluation",
      "legs",
      staleOpenInterestIndex,
      "openInterestDate",
    ]
  }
  return undefined
}

export type ProposalIntentDeriver = (
  decision: ProposedTradeDecisionV1,
  context: TradeIntentDerivationContext,
) => TradeIntentDerivationResult

export type ProcessResearchProposalPathOptions = Readonly<{
  report: ResearchReportV2
  signal: AbortSignal
  quoteProvider: OptionQuoteProvider
  shadowRiskEvaluator: ShadowRiskEvaluator
  getEligibility: () => ResearchEligibilityV1
  deriveIntent: ProposalIntentDeriver
  trace: ResearchCycleTrace
  stages: ResearchCycleStageReports
  stageReporter: TerminalStageReporter
}>

/**
 * Processes one proposed trade through trusted quotes, derivation, and shadow risk.
 *
 * This path returns terminal data but never writes to the event ledger.
 */
export async function processResearchProposalPath({
  report,
  signal,
  quoteProvider,
  shadowRiskEvaluator,
  getEligibility,
  deriveIntent,
  trace,
  stages,
  stageReporter,
}: ProcessResearchProposalPathOptions): Promise<ResearchCycleTerminalResolution> {
  const result = report.result
  if (result.outcome !== "PROPOSE_TRADE") {
    throw new Error("Proposal path requires a proposed trade report")
  }
  const evidencePreflight = await trace.run(
    "research.decision.validate",
    () => validateResearchDecisionV1(result, PROPOSAL_EVIDENCE_PREFLIGHT_CONTEXT),
  )
  if (!evidencePreflight.success) {
    return {
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: evidencePreflight.issues,
      },
    }
  }

  const proposalEligibility = getEligibility()
  if (!proposalEligibility.tradeIntentEligible) {
    return {
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["MARKET_WINDOW_INELIGIBLE"],
      },
    }
  }
  if (!proposalMarketRegimeIsFresh(report, proposalEligibility.evaluatedAt)) {
    return {
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [{
          code: "CONTEXT_INVALID",
          path: ["analysis", "marketRegime", "observedAt"],
        }],
      },
    }
  }
  if (!proposalAccountChecksAreFresh(report, proposalEligibility.evaluatedAt)) {
    return {
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [{
          code: "CONTEXT_INVALID",
          path: ["analysis", "accountChecks", "observedAt"],
        }],
      },
    }
  }
  const historyIssuePath = proposalHistoryIssuePath(report, proposalEligibility)
  if (historyIssuePath !== undefined) {
    return {
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [{ code: "CONTEXT_INVALID", path: historyIssuePath }],
      },
    }
  }

  signal.throwIfAborted()
  const quoteConfirmation = await trace.run("market.option_quotes.confirm", () =>
    quoteProvider.confirmQuotes({
      longContractSymbol: result.candidate.longLeg.contractSymbol,
      shortContractSymbol: result.candidate.shortLeg.contractSymbol,
      signal,
    }),
  )
  signal.throwIfAborted()

  if (!quoteConfirmation.success) {
    stages.quotesRejected(quoteConfirmation.reasons)
    return {
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: quoteConfirmation.reasons,
      },
    }
  }

  stages.quotesConfirmed(quoteConfirmation.snapshot)

  const evidenceSnapshots: ResearchCycleTerminalRecordV1["evidenceSnapshots"] = [
    {
      snapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
      ...quoteConfirmation.snapshot.snapshotMetadata,
      temporalClass: "LIVE",
    },
  ]

  if (
    !proposalMarketRegimeIsFresh(
      report,
      quoteConfirmation.snapshot.evaluatedAt,
    )
  ) {
    return {
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [{
          code: "CONTEXT_INVALID",
          path: ["analysis", "marketRegime", "observedAt"],
        }],
      },
      metadata: { evidenceSnapshots },
    }
  }
  if (
    !proposalAccountChecksAreFresh(
      report,
      quoteConfirmation.snapshot.evaluatedAt,
    )
  ) {
    return {
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [{
          code: "CONTEXT_INVALID",
          path: ["analysis", "accountChecks", "observedAt"],
        }],
      },
      metadata: { evidenceSnapshots },
    }
  }

  if (!getEligibility().tradeIntentEligible) {
    return {
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["MARKET_WINDOW_INELIGIBLE"],
      },
      metadata: { evidenceSnapshots },
    }
  }

  const validation = await trace.run("research.decision.validate", () =>
    validateResearchDecisionV1(result, {
      evaluatedAt: quoteConfirmation.snapshot.evaluatedAt,
      snapshots: {
        [PROPOSAL_QUOTE_SNAPSHOT_REF]:
          quoteConfirmation.snapshot.snapshotMetadata,
      },
    }),
  )
  if (!validation.success) {
    return {
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: validation.issues,
      },
      metadata: { evidenceSnapshots },
    }
  }
  if (validation.data.outcome !== "PROPOSE_TRADE") {
    return {
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [{
          code: "SCHEMA_INVALID",
          schemaCategory: "VALUE_NOT_ALLOWED",
          path: ["outcome"],
        }],
      },
      metadata: { evidenceSnapshots },
    }
  }
  const proposedDecision = validation.data
  stages.decisionValidated(proposedDecision)

  const derivation = await trace.run("research.intent.derive", () =>
    deriveIntent(proposedDecision, {
      quoteSnapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
      evaluatedAt: quoteConfirmation.snapshot.evaluatedAt,
      longQuote: quoteConfirmation.snapshot.longQuote,
      shortQuote: quoteConfirmation.snapshot.shortQuote,
    }),
  )
  if (!derivation.success) {
    stages.intentRejected(derivation.reasons)
    return {
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: derivation.reasons,
      },
      metadata: {
        evidenceSnapshots,
        validatedDecision: proposedDecision,
      },
    }
  }

  stages.intentDerived(derivation.intent)

  if (
    proposalEligibility.sessionDate === undefined ||
    proposalEligibility.tradeIntentWindow === undefined
  ) {
    return {
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["MARKET_WINDOW_INELIGIBLE"],
      },
      metadata: {
        evidenceSnapshots,
        validatedDecision: proposedDecision,
      },
    }
  }

  const shadowRisk = await trace.run("risk.shadow.evaluate", () =>
    shadowRiskEvaluator.evaluate({
      decision: proposedDecision,
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
    outcome: {
      outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
      status: "INTENT_DERIVED",
      decision: proposedDecision,
      intent: derivation.intent,
    },
    metadata: {
      evidenceSnapshots,
      validatedDecision: proposedDecision,
      shadowRisk,
    },
  }
}
