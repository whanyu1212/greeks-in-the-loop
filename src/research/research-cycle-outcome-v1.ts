import type {
  NoActionDecisionV1,
  ProposedTradeDecisionV1,
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

export type ResearchCycleOutcomeSink = Readonly<{
  record(
    outcome: ResearchCycleOutcomeV1,
    signal: AbortSignal,
  ): Promise<void>
}>

/**
 * Creates the temporary JSON-lines outcome sink used before the event ledger.
 *
 * @param write Output function, injectable for tests.
 * @returns An awaited storage-neutral outcome sink.
 */
export function createConsoleResearchCycleOutcomeSink(
  write: (line: string) => void = console.log,
): ResearchCycleOutcomeSink {
  return {
    async record(outcome, signal) {
      signal.throwIfAborted()
      write(JSON.stringify(outcome))
    },
  }
}
