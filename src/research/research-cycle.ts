import {
  deriveTradeIntentV1,
  type TradeIntentDerivationResult,
} from "../contracts/trade-intent-v1.js"
import {
  researchDecisionV1Schema,
  validateResearchDecisionV1,
  type ProposedTradeDecisionV1,
  type ResearchDecisionValidationIssue,
} from "../contracts/research-decision-v1.js"
import type {
  OptionQuoteProvider,
} from "../market-data/alpaca-option-quotes.js"
import {
  RESEARCH_CYCLE_OUTCOME_VERSION,
  type ResearchCycleOutcomeSink,
  type ResearchCycleOutcomeV1,
} from "./research-cycle-outcome-v1.js"

export const PROPOSAL_QUOTE_SNAPSHOT_REF =
  "alpaca-proposal-quotes-v1" as const
export const MAX_RESEARCH_RESPONSE_BYTES = 64 * 1024

export type ProcessResearchCycleOptions = Readonly<{
  rawResponse: string
  signal: AbortSignal
  quoteProvider: OptionQuoteProvider
  outcomeSink: ResearchCycleOutcomeSink
  now?: () => Date
  deriveIntent?: (
    decision: ProposedTradeDecisionV1,
    context: Parameters<typeof deriveTradeIntentV1>[1],
  ) => TradeIntentDerivationResult
}>

export type ProcessedResearchCycle = Readonly<{
  outcome: ResearchCycleOutcomeV1
  report: string
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
): Promise<ProcessedResearchCycle> => {
  await sink.record(outcome)
  return {
    outcome,
    report: `Research cycle outcome: ${outcome.status}`,
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
  now = () => new Date(),
  deriveIntent = deriveTradeIntentV1,
}: ProcessResearchCycleOptions): Promise<ProcessedResearchCycle> {
  if (Buffer.byteLength(rawResponse, "utf8") > MAX_RESEARCH_RESPONSE_BYTES) {
    return recordOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [{ code: "RESPONSE_TOO_LARGE", path: [] }],
      },
      outcomeSink,
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
    )
  }

  const parsedDecision = researchDecisionV1Schema.safeParse(input)
  if (!parsedDecision.success) {
    return recordOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: schemaIssues(parsedDecision.error.issues),
      },
      outcomeSink,
    )
  }

  if (parsedDecision.data.outcome === "NO_ACTION") {
    const validation = validateResearchDecisionV1(parsedDecision.data, {
      evaluatedAt: now().toISOString(),
      snapshots: {},
    })
    if (!validation.success) {
      return recordOutcome(
        {
          outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
          status: "DECISION_REJECTED",
          issues: validation.issues,
        },
        outcomeSink,
      )
    }

    return recordOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "VALIDATED_NO_ACTION",
        decision: parsedDecision.data,
      },
      outcomeSink,
    )
  }

  const quoteConfirmation = await quoteProvider.confirmQuotes({
    longContractSymbol:
      parsedDecision.data.candidate.longLeg.contractSymbol,
    shortContractSymbol:
      parsedDecision.data.candidate.shortLeg.contractSymbol,
    signal,
  })
  if (!quoteConfirmation.success) {
    return recordOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: quoteConfirmation.reasons,
      },
      outcomeSink,
    )
  }

  const validation = validateResearchDecisionV1(parsedDecision.data, {
    evaluatedAt: quoteConfirmation.snapshot.evaluatedAt,
    snapshots: {
      [PROPOSAL_QUOTE_SNAPSHOT_REF]:
        quoteConfirmation.snapshot.snapshotMetadata,
    },
  })
  if (!validation.success) {
    return recordOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: validation.issues,
      },
      outcomeSink,
    )
  }
  if (validation.data.outcome !== "PROPOSE_TRADE") {
    return recordOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [{ code: "SCHEMA_INVALID", path: ["outcome"] }],
      },
      outcomeSink,
    )
  }

  const derivation = deriveIntent(validation.data, {
    quoteSnapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
    evaluatedAt: quoteConfirmation.snapshot.evaluatedAt,
    longQuote: quoteConfirmation.snapshot.longQuote,
    shortQuote: quoteConfirmation.snapshot.shortQuote,
  })
  if (!derivation.success) {
    return recordOutcome(
      {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "INTENT_DERIVATION_REJECTED",
        reasons: derivation.reasons,
      },
      outcomeSink,
    )
  }

  return recordOutcome(
    {
      outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
      status: "INTENT_DERIVED",
      decision: validation.data,
      intent: derivation.intent,
    },
    outcomeSink,
  )
}
