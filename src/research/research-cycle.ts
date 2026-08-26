import {
  deriveTradeIntentV1,
  type TradeIntentDerivationResult,
} from "../contracts/trade-intent-v1.js"
import {
  validateResearchDecisionV1,
  type ProposedTradeDecisionV1,
  type ResearchDecisionV1,
  type ResearchDecisionValidationIssue,
} from "../contracts/research-decision-v1.js"
import {
  researchReportV2Schema,
  type ResearchReportV2,
} from "../contracts/research-report-v2.js"
import { MAX_LEDGER_EVENT_PAYLOAD_BYTES } from "../event-ledger/ledger-event-v1.js"
import type {
  OptionQuoteProvider,
} from "../market-data/alpaca-option-quotes.js"
import type { ResearchEligibilityV1 } from "../scheduling/research-eligibility.js"
import {
  RESEARCH_CYCLE_OUTCOME_VERSION,
  type ResearchCycleOutcomeSink,
  type ResearchCycleOutcomeV1,
  type ResearchCycleTerminalRecordV1,
} from "./research-cycle-outcome-v1.js"

export const PROPOSAL_QUOTE_SNAPSHOT_REF =
  "alpaca-proposal-quotes-v1" as const
export const MAX_RESEARCH_RESPONSE_BYTES = 64 * 1024
const MAX_TERMINAL_REJECTION_DETAILS = 64
const MAX_PROPOSAL_MARKET_REGIME_AGE_MS = 60_000

// This context validates proposal evidence topology and restricts every sourced
// fact to the application-owned quote alias before any provider request. Real
// quote timestamps replace it for the authoritative post-fetch validation.
const PROPOSAL_EVIDENCE_PREFLIGHT_CONTEXT = {
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
  signal: AbortSignal
  quoteProvider: OptionQuoteProvider
  outcomeSink: ResearchCycleOutcomeSink
  getEligibility: () => ResearchEligibilityV1
  now?: () => Date
  deriveIntent?: (
    decision: ProposedTradeDecisionV1,
    context: Parameters<typeof deriveTradeIntentV1>[1],
  ) => TradeIntentDerivationResult
}>

export type ProcessedResearchCycle = Readonly<{
  outcome: ResearchCycleOutcomeV1
  report: string
  researchReport?: ResearchReportV2
}>

const schemaIssues = (
  issues: readonly { path: readonly PropertyKey[] }[],
): ResearchDecisionValidationIssue[] =>
  issues.map(({ path }) => ({
    code: "SCHEMA_INVALID",
    path: path.map((part) =>
      typeof part === "symbol" ? String(part) : part,
    ),
  }))

const proposalMarketRegimeIsFresh = (
  report: ResearchReportV2,
  evaluatedAt: string,
) => {
  const evaluationTime = Date.parse(evaluatedAt)
  const observedAt = Date.parse(report.analysis.marketRegime.observedAt)
  const age = evaluationTime - observedAt
  return (
    Number.isFinite(evaluationTime) &&
    Number.isFinite(observedAt) &&
    age >= 0 &&
    age <= MAX_PROPOSAL_MARKET_REGIME_AGE_MS
  )
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
  metadata: TerminalRecordMetadata = {},
): Promise<ProcessedResearchCycle> => {
  signal.throwIfAborted()
  const boundedOutcome = boundTerminalOutcome(outcome)
  const record: ResearchCycleTerminalRecordV1 = {
    outcome: boundedOutcome,
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
  await sink.record(record, signal)
  return {
    outcome: boundedOutcome,
    report: `Research cycle outcome: ${boundedOutcome.status}`,
    ...(metadata.researchReport === undefined
      ? {}
      : { researchReport: metadata.researchReport }),
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
  signal,
  quoteProvider,
  outcomeSink,
  getEligibility,
  now = () => new Date(),
  deriveIntent = deriveTradeIntentV1,
}: ProcessResearchCycleOptions): Promise<ProcessedResearchCycle> {
  signal.throwIfAborted()

  if (Buffer.byteLength(rawResponse, "utf8") > MAX_RESEARCH_RESPONSE_BYTES) {
    return recordOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [{ code: "RESPONSE_TOO_LARGE", path: [] }],
      },
      outcomeSink,
      signal,
    )
  }

  let input: unknown
  try {
    input = JSON.parse(rawResponse)
  } catch {
    return recordOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [{ code: "MALFORMED_JSON", path: [] }],
      },
      outcomeSink,
      signal,
    )
  }

  const parsedReport = researchReportV2Schema.safeParse(input)
  if (!parsedReport.success) {
    return recordOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: schemaIssues(parsedReport.error.issues),
      },
      outcomeSink,
      signal,
    )
  }

  if (
    Buffer.byteLength(
      JSON.stringify({
        researchReport: parsedReport.data,
      }),
      "utf8",
    ) > MAX_LEDGER_EVENT_PAYLOAD_BYTES
  ) {
    return recordOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [{ code: "RESPONSE_TOO_LARGE", path: [] }],
      },
      outcomeSink,
      signal,
    )
  }

  const researchReport = parsedReport.data
  const result = researchReport.result
  const recordReportOutcome = (
    outcome: ResearchCycleOutcomeV1,
    metadata: TerminalRecordMetadata = {},
  ) =>
    recordOutcome(outcome, outcomeSink, signal, {
      ...metadata,
      researchReport,
    })
  const processingEvaluatedAt = now()
  if (
    !Number.isFinite(processingEvaluatedAt.getTime()) ||
    Date.parse(researchReport.analysis.asOf) > processingEvaluatedAt.getTime()
  ) {
    return recordReportOutcome({
      outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
      status: "DECISION_REJECTED",
      issues: [{ code: "CONTEXT_INVALID", path: ["analysis", "asOf"] }],
    })
  }

  if (result.outcome === "PRELIMINARY_RESEARCH") {
    const eligibility = getEligibility()
    const eligibilityTime = Date.parse(eligibility.evaluatedAt)
    const futureObservationIndex = result.evidence.findIndex(
      (claim) =>
        claim.kind === "SOURCED_FACT" &&
        Date.parse(claim.observedAt) > eligibilityTime,
    )
    if (
      !eligibility.researchEligible ||
      eligibility.sessionDate !== result.targetSessionDate ||
      !Number.isFinite(eligibilityTime) ||
      Date.parse(researchReport.analysis.asOf) > eligibilityTime ||
      futureObservationIndex >= 0
    ) {
      const issuePath =
        futureObservationIndex >= 0
          ? ["evidence", futureObservationIndex, "observedAt"]
          : ["targetSessionDate"]
      return recordReportOutcome(
        {
          outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
          status: "DECISION_REJECTED",
          issues: [
            {
              code: "CONTEXT_INVALID",
              path: issuePath,
            },
          ],
        },
      )
    }
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
    const validation = validateResearchDecisionV1(result, {
      evaluatedAt: processingEvaluatedAt.toISOString(),
      snapshots: {},
    })
    if (!validation.success) {
      return recordReportOutcome(
        {
          outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
          status: "DECISION_REJECTED",
          issues: validation.issues,
        },
      )
    }

    return recordReportOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "VALIDATED_NO_ACTION",
        decision: result,
      },
      { validatedDecision: validation.data },
    )
  }

  const evidencePreflight = validateResearchDecisionV1(
    result,
    PROPOSAL_EVIDENCE_PREFLIGHT_CONTEXT,
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

  signal.throwIfAborted()
  const quoteConfirmation = await quoteProvider.confirmQuotes({
    longContractSymbol: result.candidate.longLeg.contractSymbol,
    shortContractSymbol: result.candidate.shortLeg.contractSymbol,
    signal,
  })
  signal.throwIfAborted()

  if (!quoteConfirmation.success) {
    return recordReportOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: quoteConfirmation.reasons,
      },
    )
  }

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

  const validation = validateResearchDecisionV1(result, {
    evaluatedAt: quoteConfirmation.snapshot.evaluatedAt,
    snapshots: {
      [PROPOSAL_QUOTE_SNAPSHOT_REF]:
        quoteConfirmation.snapshot.snapshotMetadata,
    },
  })
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
        issues: [{ code: "SCHEMA_INVALID", path: ["outcome"] }],
      },
      { evidenceSnapshots },
    )
  }

  const derivation = deriveIntent(validation.data, {
    quoteSnapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
    evaluatedAt: quoteConfirmation.snapshot.evaluatedAt,
    longQuote: quoteConfirmation.snapshot.longQuote,
    shortQuote: quoteConfirmation.snapshot.shortQuote,
  })
  if (!derivation.success) {
    return recordReportOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: derivation.reasons,
      },
      {
        evidenceSnapshots,
        validatedDecision: validation.data,
      },
    )
  }

  return recordReportOutcome(
    {
      outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
      status: "INTENT_DERIVED",
      decision: validation.data,
      intent: derivation.intent,
    },
    {
      evidenceSnapshots,
      validatedDecision: validation.data,
    },
  )
}
