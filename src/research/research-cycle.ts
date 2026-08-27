import {
  deriveTradeIntentV1,
  type TradeIntentDerivationResult,
} from "../contracts/trade-intent-v1.js"
import {
  STRATEGY_VERSION,
  validateResearchDecisionV1,
  type ProposedTradeDecisionV1,
  type ResearchDecisionV1,
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
  type TerminalStageValue,
} from "../observability/terminal-stage-reporter.js"
import {
  newYorkLocalTime,
  type ResearchEligibilityV1,
} from "../scheduling/research-eligibility.js"
import type { ShadowRiskEvaluator } from "../risk/shadow-risk-service.js"
import type { ShadowRiskResultV1 } from "../risk/shadow-risk-v1.js"
import { safeSchemaDiagnostics } from "../shared/schema-diagnostics.js"
import {
  RESEARCH_CYCLE_OUTCOME_VERSION,
  type ResearchCycleOutcomeSink,
  type ResearchCycleOutcomeV1,
  type ResearchCycleTerminalRecordV1,
} from "./research-cycle-outcome-v1.js"
import type { ResearchInvocationV1 } from "./research-invocation-v1.js"

export const PROPOSAL_QUOTE_SNAPSHOT_REF =
  "alpaca-proposal-quotes-v1" as const
export const MAX_RESEARCH_RESPONSE_BYTES = 64 * 1024
export const MAX_TERMINAL_REJECTION_DETAILS = 64
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

export type ProcessedResearchCycle = Readonly<{
  outcome: ResearchCycleOutcomeV1
  report: string
  researchReport?: ResearchReportV2
  shadowRisk?: ShadowRiskResultV1
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

const boundTerminalOutcome = (
  outcome: ResearchCycleOutcomeV1,
): ResearchCycleOutcomeV1 => {
  if (outcome.status === "DECISION_REJECTED") {
    return {
      ...outcome,
      issues: outcome.issues.slice(0, MAX_TERMINAL_REJECTION_DETAILS),
    }
  }
  if (outcome.status === "INTENT_DERIVATION_REJECTED") {
    return {
      ...outcome,
      reasons: outcome.reasons.slice(0, MAX_TERMINAL_REJECTION_DETAILS),
    }
  }
  return outcome
}

type TerminalRecordMetadata = Readonly<{
  evidenceSnapshots?: ResearchCycleTerminalRecordV1["evidenceSnapshots"]
  validatedDecision?: ResearchDecisionV1
  preliminaryResearch?: ResearchCycleTerminalRecordV1["preliminaryResearch"]
  researchReport?: ResearchReportV2
  shadowRisk?: ShadowRiskResultV1
}>

/**
 * Records one bounded cycle outcome before returning it to the scheduler.
 *
 * @param outcome Bounded processing result.
 * @param sink Awaited storage-neutral record sink.
 * @returns The outcome and a concise printable status.
 */
const recordOutcome = async (
  outcome: ResearchCycleOutcomeV1,
  sink: ResearchCycleOutcomeSink,
  signal: AbortSignal,
  researchInvocation: ResearchInvocationV1,
  metadata: TerminalRecordMetadata = {},
  trace: ResearchCycleTrace = NOOP_RESEARCH_CYCLE_TRACE,
  stageReporter: TerminalStageReporter = NOOP_TERMINAL_STAGE_REPORTER,
): Promise<ProcessedResearchCycle> => {
  signal.throwIfAborted()
  const boundedOutcome = boundTerminalOutcome(outcome)
  const commonRecord = {
    researchInvocation,
    evidenceSnapshots: metadata.evidenceSnapshots ?? [],
    ...(metadata.validatedDecision === undefined
      ? {}
      : { validatedDecision: metadata.validatedDecision }),
    ...(metadata.preliminaryResearch === undefined
      ? {}
      : { preliminaryResearch: metadata.preliminaryResearch }),
    ...(metadata.researchReport === undefined
      ? {}
      : { researchReport: metadata.researchReport }),
  }
  let record: ResearchCycleTerminalRecordV1
  if (boundedOutcome.status === "INTENT_DERIVED") {
    if (metadata.shadowRisk === undefined) {
      throw new Error("Derived intent outcome requires shadow risk")
    }
    record = {
      ...commonRecord,
      outcome: boundedOutcome,
      shadowRisk: metadata.shadowRisk,
    }
  } else {
    if (metadata.shadowRisk !== undefined) {
      throw new Error("Shadow risk requires a derived intent outcome")
    }
    record = { ...commonRecord, outcome: boundedOutcome }
  }
  await trace.run("ledger.cycle.terminalize", () => sink.record(record, signal))
  stageReporter.report("ledger.commit", "COMPLETED", {
    outcomeStatus: boundedOutcome.status,
    evidenceSnapshotCount: commonRecord.evidenceSnapshots.length,
    shadowRiskRecorded: metadata.shadowRisk !== undefined,
  })
  const terminalDetails: Record<string, TerminalStageValue> = {
    outcomeStatus: boundedOutcome.status,
  }
  if (boundedOutcome.status === "DECISION_REJECTED") {
    terminalDetails.issues = boundedOutcome.issues.map(
      ({ code, path }) => `${code}:${path.join(".")}`,
    )
  } else if (boundedOutcome.status === "INTENT_DERIVATION_REJECTED") {
    terminalDetails.reasonCodes = boundedOutcome.reasons
  } else if (boundedOutcome.status === "VALIDATED_NO_ACTION") {
    terminalDetails.reasonCodes = boundedOutcome.decision.reasonCodes
  } else if (boundedOutcome.status === "PRELIMINARY_RESEARCH_RETAINED") {
    terminalDetails.direction = boundedOutcome.research.direction
  } else {
    terminalDetails.direction = boundedOutcome.decision.direction
    terminalDetails.riskOutcome = metadata.shadowRisk!.decision.outcome
  }
  stageReporter.report(
    "cycle.outcome",
    boundedOutcome.status === "INTENT_DERIVED" ||
      boundedOutcome.status === "VALIDATED_NO_ACTION" ||
      boundedOutcome.status === "PRELIMINARY_RESEARCH_RETAINED"
      ? "COMPLETED"
      : "REJECTED",
    terminalDetails,
  )
  return {
    outcome: boundedOutcome,
    report: `Research cycle outcome: ${boundedOutcome.status}${
      metadata.shadowRisk === undefined
        ? ""
        : `\nShadow risk: ${metadata.shadowRisk.decision.outcome}`
    }`,
    ...(metadata.researchReport === undefined
      ? {}
      : { researchReport: metadata.researchReport }),
    ...(metadata.shadowRisk === undefined
      ? {}
      : { shadowRisk: metadata.shadowRisk }),
  }
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
    stageReporter.report("research.report", "REJECTED", {
      issues: parsed.issues.map(({ code, path }) => `${code}:${path.join(".")}`),
    })
    return recordOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: parsed.issues,
      },
      outcomeSink,
      signal,
      researchInvocation,
      {},
      trace,
      stageReporter,
    )
  }

  const researchReport = parsed.report
  const result = researchReport.result
  const recordReportOutcome = (
    outcome: ResearchCycleOutcomeV1,
    metadata: TerminalRecordMetadata = {},
  ) =>
    recordOutcome(
      outcome,
      outcomeSink,
      signal,
      researchInvocation,
      { ...metadata, researchReport },
      trace,
      stageReporter,
    )
  stageReporter.report("research.report", "COMPLETED", {
    reportVersion: researchReport.reportVersion,
    strategyVersion: result.strategyVersion,
    resultOutcome: result.outcome,
    externalSourceCount: researchReport.analysis.externalContext.length,
    hasCandidate:
      result.outcome === "PROPOSE_TRADE" ||
      (result.outcome === "PRELIMINARY_RESEARCH" &&
        result.candidate !== undefined),
  })
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
    stageReporter.report("preliminary.validate", "COMPLETED", {
      direction: result.direction,
      targetSessionDate: result.targetSessionDate,
      evidenceCount: result.evidence.length,
      hasCandidate: result.candidate !== undefined,
    })
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

    stageReporter.report("decision.validate", "COMPLETED", {
      outcome: validation.data.outcome,
      reasonCodes: result.reasonCodes,
    })

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
    stageReporter.report("quotes.confirm", "REJECTED", {
      reasonCodes: quoteConfirmation.reasons,
    })
    return recordReportOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: quoteConfirmation.reasons,
      },
    )
  }

  stageReporter.report("quotes.confirm", "COMPLETED", {
    longContractSymbol: quoteConfirmation.snapshot.longQuote.contractSymbol,
    shortContractSymbol: quoteConfirmation.snapshot.shortQuote.contractSymbol,
    source: quoteConfirmation.snapshot.snapshotMetadata.source,
    retrievedAt: quoteConfirmation.snapshot.snapshotMetadata.retrievedAt,
    freshUntil: quoteConfirmation.snapshot.snapshotMetadata.freshUntil,
  })

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
  stageReporter.report("decision.validate", "COMPLETED", {
    outcome: proposedDecision.outcome,
    direction: proposedDecision.direction,
    structure: proposedDecision.candidate.structure,
    expiration: proposedDecision.candidate.expiration,
    evidenceCount: proposedDecision.evidence.length,
  })

  const derivation = await trace.run("research.intent.derive", () =>
    deriveIntent(proposedDecision, {
      quoteSnapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
      evaluatedAt: quoteConfirmation.snapshot.evaluatedAt,
      longQuote: quoteConfirmation.snapshot.longQuote,
      shortQuote: quoteConfirmation.snapshot.shortQuote,
    }),
  )
  if (!derivation.success) {
    stageReporter.report("intent.derive", "REJECTED", {
      reasonCodes: derivation.reasons,
    })
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

  stageReporter.report("intent.derive", "COMPLETED", {
    direction: derivation.intent.direction,
    structure: derivation.intent.structure,
    expiration: derivation.intent.expiration,
    entryLimitCentsPerShare: derivation.intent.entryLimitCentsPerShare,
    maxLossCentsPerContract: derivation.intent.maxLossCentsPerContract,
    maxProfitCentsPerContract: derivation.intent.maxProfitCentsPerContract,
  })

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

  const riskDecision = shadowRisk.decision
  const riskReasonCodes =
    riskDecision.stage === "STATE_CAPTURE_FAILED"
      ? riskDecision.captureReasonCodes
      : riskDecision.stage === "INTENT_REFRESH_FAILED"
        ? riskDecision.derivationReasonCodes
        : riskDecision.evaluation.outcome === "REJECTED"
          ? riskDecision.evaluation.reasonCodes
          : []
  stageReporter.report(
    "risk.evaluate",
    riskDecision.outcome === "APPROVED" ? "COMPLETED" : "REJECTED",
    {
      evaluationStage: riskDecision.stage,
      outcome: riskDecision.outcome,
      reasonCodes: riskReasonCodes,
      breakerTransitions: shadowRisk.breakerTransitions.map(
        ({ breaker }) => breaker,
      ),
    },
  )

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
