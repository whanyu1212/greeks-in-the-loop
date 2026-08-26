import type {
  EvidenceSnapshotMetadata,
  NoActionDecisionV1,
  ProposedTradeDecisionV1,
  ResearchDecisionV1,
  ResearchDecisionValidationIssue,
} from "../contracts/research-decision-v1.js"
import type {
  TradeIntentDerivationReason,
  TradeIntentV1,
} from "../contracts/trade-intent-v1.js"
import type {
  OptionQuoteConfirmationFailureCode,
} from "../market-data/alpaca-option-quotes.js"

export const RESEARCH_CYCLE_OUTCOME_VERSION = "1.0.0" as const

export type DecisionRejectionIssue =
  | ResearchDecisionValidationIssue
  | {
      code: "MALFORMED_JSON" | "RESPONSE_TOO_LARGE"
      path: readonly []
    }

export type IntentDerivationRejectionReason =
  | OptionQuoteConfirmationFailureCode
  | TradeIntentDerivationReason

export type ResearchCycleOutcomeV1 =
  | {
      outcomeVersion: typeof RESEARCH_CYCLE_OUTCOME_VERSION
      status: "VALIDATED_NO_ACTION"
      decision: NoActionDecisionV1
    }
  | {
      outcomeVersion: typeof RESEARCH_CYCLE_OUTCOME_VERSION
      status: "DECISION_REJECTED"
      issues: readonly DecisionRejectionIssue[]
    }
  | {
      outcomeVersion: typeof RESEARCH_CYCLE_OUTCOME_VERSION
      status: "INTENT_DERIVATION_REJECTED"
      reasons: readonly IntentDerivationRejectionReason[]
    }
  | {
      outcomeVersion: typeof RESEARCH_CYCLE_OUTCOME_VERSION
      status: "INTENT_DERIVED"
      decision: ProposedTradeDecisionV1
      intent: TradeIntentV1
    }

export type ResearchCycleEvidenceSnapshotReferenceV1 = Readonly<{
  snapshotRef: string
  provider: EvidenceSnapshotMetadata["provider"]
  source: string
  retrievedAt: string
  freshUntil: string
}>

export type ResearchCycleTerminalRecordV1 = Readonly<{
  outcome: ResearchCycleOutcomeV1
  evidenceSnapshots: readonly ResearchCycleEvidenceSnapshotReferenceV1[]
  validatedDecision?: ResearchDecisionV1
}>

export type ResearchCycleOutcomeSink = Readonly<{
  record(
    record: ResearchCycleTerminalRecordV1,
    signal: AbortSignal,
  ): Promise<void>
}>

/**
 * Creates an optional JSON-lines adapter for local diagnostics and tests.
 *
 * @param write Output function, injectable for tests.
 * @returns An awaited storage-neutral outcome sink.
 */
export function createConsoleResearchCycleOutcomeSink(
  write: (line: string) => void = console.log,
): ResearchCycleOutcomeSink {
  return {
    async record(record, signal) {
      signal.throwIfAborted()
      write(JSON.stringify(record.outcome))
    },
  }
}
