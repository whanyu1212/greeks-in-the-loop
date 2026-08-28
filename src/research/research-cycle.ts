import {
  deriveTradeIntentV1,
  type TradeIntentDerivationResult,
} from "../contracts/trade-intent-v1.js"
import {
  STRATEGY_VERSION,
  validateResearchDecisionV1,
  type ProposedTradeDecisionV1,
} from "../contracts/research-decision-v1.js"
import {
  researchReportV2Schema,
  type ResearchReportV2,
} from "../contracts/research-report-v2.js"
import { MAX_LEDGER_EVENT_PAYLOAD_BYTES } from "../event-ledger/ledger-event-v1.js"
import type {
  OptionQuoteProvider,
} from "../market-data/alpaca-option-quotes.js"
import {
  NOOP_RESEARCH_CYCLE_TRACE,
  type ResearchCycleTrace,
} from "../observability/research-telemetry.js"
import {
  NOOP_TERMINAL_STAGE_REPORTER,
  type TerminalStageReporter,
} from "../observability/terminal-stage-reporter.js"
import {
  newYorkLocalTime,
  type ResearchEligibilityV1,
} from "../scheduling/research-eligibility.js"
import type { ShadowRiskEvaluator } from "../risk/shadow-risk-service.js"
import { safeSchemaDiagnostics } from "../shared/schema-diagnostics.js"
import {
  RESEARCH_CYCLE_OUTCOME_VERSION,
  type ResearchCycleOutcomeSink,
  type ResearchCycleOutcomeV1,
  type ResearchCycleTerminalRecordV1,
} from "./research-cycle-outcome-v1.js"
import { createResearchCycleStageReports } from "./research-cycle-stage-reporting.js"
import {
  recordResearchCycleOutcome,
  type ProcessedResearchCycle,
  type ResearchCycleTerminalMetadata,
  type ResearchCycleTerminalResolution,
} from "./research-cycle-terminal.js"
import type { ResearchInvocationV1 } from "./research-invocation-v1.js"

export {
  MAX_TERMINAL_REJECTION_DETAILS,
  type ProcessedResearchCycle,
} from "./research-cycle-terminal.js"

export const PROPOSAL_QUOTE_SNAPSHOT_REF =
  "alpaca-proposal-quotes-v1" as const
export const MAX_RESEARCH_RESPONSE_BYTES = 64 * 1024
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

export type ProcessResearchCycleOptions = Readonly<{
  rawResponse: string
  cycleStartedAt: string
  signal: AbortSignal
  quoteProvider: OptionQuoteProvider
  shadowRiskEvaluator: ShadowRiskEvaluator
  outcomeSink: ResearchCycleOutcomeSink
  getEligibility: () => ResearchEligibilityV1
  researchInvocation: ResearchInvocationV1
  now?: () => Date
  deriveIntent?: (
    decision: ProposedTradeDecisionV1,
    context: Parameters<typeof deriveTradeIntentV1>[1],
  ) => TradeIntentDerivationResult
  trace?: ResearchCycleTrace
  stageReporter?: TerminalStageReporter
}>

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

/**
 * Parses, validates, confirms, and derives one research-agent response.
 *
 * The raw response is never placed in a rejection result. Quote confirmation and
 * intent derivation are unreachable until the decision passes its preceding
 * validation gate.
 *
 * @param options Untrusted response and application-owned processing ports.
 * @returns One recorded bounded outcome and printable scheduler report.
 */
export async function processResearchCycle({
  rawResponse,
  cycleStartedAt,
  signal,
  quoteProvider,
  shadowRiskEvaluator,
  outcomeSink,
  getEligibility,
  researchInvocation,
  now = () => new Date(),
  deriveIntent = deriveTradeIntentV1,
  trace = NOOP_RESEARCH_CYCLE_TRACE,
  stageReporter = NOOP_TERMINAL_STAGE_REPORTER,
}: ProcessResearchCycleOptions): Promise<ProcessedResearchCycle> {
  signal.throwIfAborted()
  const stages = createResearchCycleStageReports(stageReporter)
  const parsed = await trace.run("research.report.parse", () => {
    if (Buffer.byteLength(rawResponse, "utf8") > MAX_RESEARCH_RESPONSE_BYTES) {
      return {
        success: false as const,
        issues: [{ code: "RESPONSE_TOO_LARGE" as const, path: [] as const }],
      }
    }
    let input: unknown
    try {
      input = JSON.parse(rawResponse)
    } catch {
      return {
        success: false as const,
        issues: [{ code: "MALFORMED_JSON" as const, path: [] as const }],
      }
    }
    const report = researchReportV2Schema.safeParse(input)
    if (!report.success) {
      return {
        success: false as const,
        issues: safeSchemaDiagnostics(report.error.issues, input),
      }
    }
    if (
      Buffer.byteLength(JSON.stringify({ researchReport: report.data }), "utf8") >
      MAX_LEDGER_EVENT_PAYLOAD_BYTES
    ) {
      return {
        success: false as const,
        issues: [{ code: "RESPONSE_TOO_LARGE" as const, path: [] as const }],
      }
    }
    return { success: true as const, report: report.data }
  })
  if (!parsed.success) {
    stages.researchReportRejected(parsed.issues)
    return recordResearchCycleOutcome(
      {
        outcome: {
          outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
          status: "DECISION_REJECTED",
          issues: parsed.issues,
        },
      },
      {
        sink: outcomeSink,
        signal,
        researchInvocation,
        trace,
        stages,
      },
    )
  }

  const researchReport = parsed.report
  const result = researchReport.result
  const recordReportOutcome = (
    outcome: ResearchCycleOutcomeV1,
    metadata: ResearchCycleTerminalMetadata = {},
  ) =>
    recordResearchCycleOutcome(
      { outcome, metadata } as ResearchCycleTerminalResolution,
      {
        sink: outcomeSink,
        signal,
        researchInvocation,
        researchReport,
        trace,
        stages,
      },
    )
  stages.researchReportCompleted(researchReport)
  if (result.strategyVersion !== STRATEGY_VERSION) {
    return recordReportOutcome({
      outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
      status: "DECISION_REJECTED",
      issues: [{
        code: "SCHEMA_INVALID",
        schemaCategory: "VALUE_NOT_ALLOWED",
        path: ["result", "strategyVersion"],
      }],
    })
  }
  const processingEvaluatedAt = now()
  const cycleStartTime = Date.parse(cycleStartedAt)
  if (
    !Number.isFinite(processingEvaluatedAt.getTime()) ||
    !Number.isFinite(cycleStartTime) ||
    cycleStartTime > processingEvaluatedAt.getTime() ||
    Date.parse(researchReport.analysis.asOf) > processingEvaluatedAt.getTime()
  ) {
    return recordReportOutcome({
      outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
      status: "DECISION_REJECTED",
      issues: [{ code: "CONTEXT_INVALID", path: ["analysis", "asOf"] }],
    })
  }
  const exaSources = researchReport.analysis.externalContext.filter(
    ({ provider }) => provider === "EXA",
  )
  if (
    exaSources.length > 0 &&
    !exaSources.some(({ retrievedAt }) => {
      const retrievedTime = Date.parse(retrievedAt)
      return (
        retrievedTime >= cycleStartTime &&
        retrievedTime <= processingEvaluatedAt.getTime()
      )
    })
  ) {
    return recordReportOutcome({
      outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
      status: "DECISION_REJECTED",
      issues: [
        {
          code: "CONTEXT_INVALID",
          path: ["analysis", "externalContext"],
        },
      ],
    })
  }

  if (result.outcome === "PRELIMINARY_RESEARCH") {
    const preliminaryIssuePath = await trace.run(
      "research.decision.validate",
      () => {
        const eligibility = getEligibility()
        const eligibilityTime = Date.parse(eligibility.evaluatedAt)
        const futureObservationIndex = result.evidence.findIndex(
          (claim) =>
            claim.kind === "SOURCED_FACT" &&
            Date.parse(claim.observedAt) > eligibilityTime,
        )
        if (
          eligibility.researchEligible &&
          eligibility.sessionDate === result.targetSessionDate &&
          Number.isFinite(eligibilityTime) &&
          Date.parse(researchReport.analysis.asOf) <= eligibilityTime &&
          futureObservationIndex < 0
        ) {
          return undefined
        }
        return futureObservationIndex >= 0
          ? ["evidence", futureObservationIndex, "observedAt"] as const
          : ["targetSessionDate"] as const
      },
    )
    if (preliminaryIssuePath !== undefined) {
      return recordReportOutcome(
        {
          outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
          status: "DECISION_REJECTED",
          issues: [
            {
              code: "CONTEXT_INVALID",
              path: preliminaryIssuePath,
            },
          ],
        },
      )
    }
    stages.preliminaryValidated(result)
    return recordReportOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "PRELIMINARY_RESEARCH_RETAINED",
        research: result,
      },
      { preliminaryResearch: result },
    )
  }

  if (result.outcome === "NO_ACTION") {
    const validation = await trace.run("research.decision.validate", () =>
      validateResearchDecisionV1(result, {
        evaluatedAt: processingEvaluatedAt.toISOString(),
        snapshots: {},
      }),
    )
    if (!validation.success) {
      return recordReportOutcome(
        {
          outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
          status: "DECISION_REJECTED",
          issues: validation.issues,
        },
      )
    }

    stages.decisionValidated(validation.data)

    return recordReportOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "VALIDATED_NO_ACTION",
        decision: result,
      },
      { validatedDecision: validation.data },
    )
  }

  const evidencePreflight = await trace.run(
    "research.decision.validate",
    () => validateResearchDecisionV1(result, PROPOSAL_EVIDENCE_PREFLIGHT_CONTEXT),
  )
  if (!evidencePreflight.success) {
    return recordReportOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: evidencePreflight.issues,
      },
    )
  }

  const proposalEligibility = getEligibility()
  if (!proposalEligibility.tradeIntentEligible) {
    return recordReportOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["MARKET_WINDOW_INELIGIBLE"],
      },
    )
  }
  if (!proposalMarketRegimeIsFresh(researchReport, proposalEligibility.evaluatedAt)) {
    return recordReportOutcome({
      outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
      status: "DECISION_REJECTED",
      issues: [
        {
          code: "CONTEXT_INVALID",
          path: ["analysis", "marketRegime", "observedAt"],
        },
      ],
    })
  }
  if (!proposalAccountChecksAreFresh(researchReport, proposalEligibility.evaluatedAt)) {
    return recordReportOutcome({
      outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
      status: "DECISION_REJECTED",
      issues: [
        {
          code: "CONTEXT_INVALID",
          path: ["analysis", "accountChecks", "observedAt"],
        },
      ],
    })
  }
  const historyIssuePath = proposalHistoryIssuePath(
    researchReport,
    proposalEligibility,
  )
  if (historyIssuePath !== undefined) {
    return recordReportOutcome({
      outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
      status: "DECISION_REJECTED",
      issues: [{ code: "CONTEXT_INVALID", path: historyIssuePath }],
    })
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
    return recordReportOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: quoteConfirmation.reasons,
      },
    )
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
      researchReport,
      quoteConfirmation.snapshot.evaluatedAt,
    )
  ) {
    return recordReportOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [
          {
            code: "CONTEXT_INVALID",
            path: ["analysis", "marketRegime", "observedAt"],
          },
        ],
      },
      { evidenceSnapshots },
    )
  }
  if (
    !proposalAccountChecksAreFresh(
      researchReport,
      quoteConfirmation.snapshot.evaluatedAt,
    )
  ) {
    return recordReportOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [
          {
            code: "CONTEXT_INVALID",
            path: ["analysis", "accountChecks", "observedAt"],
          },
        ],
      },
      { evidenceSnapshots },
    )
  }

  if (!getEligibility().tradeIntentEligible) {
    return recordReportOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["MARKET_WINDOW_INELIGIBLE"],
      },
      { evidenceSnapshots },
    )
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
    return recordReportOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: validation.issues,
      },
      { evidenceSnapshots },
    )
  }
  if (validation.data.outcome !== "PROPOSE_TRADE") {
    return recordReportOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [{
          code: "SCHEMA_INVALID",
          schemaCategory: "VALUE_NOT_ALLOWED",
          path: ["outcome"],
        }],
      },
      { evidenceSnapshots },
    )
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
    return recordReportOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: derivation.reasons,
      },
      {
        evidenceSnapshots,
        validatedDecision: proposedDecision,
      },
    )
  }

  stages.intentDerived(derivation.intent)

  if (
    proposalEligibility.sessionDate === undefined ||
    proposalEligibility.tradeIntentWindow === undefined
  ) {
    return recordReportOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["MARKET_WINDOW_INELIGIBLE"],
      },
      {
        evidenceSnapshots,
        validatedDecision: proposedDecision,
      },
    )
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

  return recordReportOutcome(
    {
      outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
      status: "INTENT_DERIVED",
      decision: proposedDecision,
      intent: derivation.intent,
    },
    {
      evidenceSnapshots,
      validatedDecision: proposedDecision,
      shadowRisk,
    },
  )
}
