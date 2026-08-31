import type {
  EvidenceSnapshotMetadata,
  NoActionDecisionV2,
  ProposedTradeDecisionV2,
  ResearchDecisionV2,
  ResearchDecisionValidationIssue,
} from "../contracts/research-decision-v2.js"
import type { PreliminaryResearchV2 } from "../contracts/preliminary-research-v2.js"
import type { ResearchReportV3 } from "../contracts/research-report-v3.js"
import type {
  TradeIntentDerivationReason,
  TradeIntentV2,
} from "../contracts/trade-intent-v2.js"
import type {
  OptionQuoteConfirmationFailureCode,
} from "../market-data/alpaca-option-quotes.js"
import type { ShadowRiskResultV1 } from "../risk/shadow-risk-v1.js"
import type { ResearchInvocationV1 } from "./research-invocation-v1.js"

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
  | "MARKET_WINDOW_INELIGIBLE"

export type ResearchCycleOutcomeV1 =
  | {
      outcomeVersion: typeof RESEARCH_CYCLE_OUTCOME_VERSION
      status: "PRELIMINARY_RESEARCH_RETAINED"
      research: PreliminaryResearchV2
    }
  | {
      outcomeVersion: typeof RESEARCH_CYCLE_OUTCOME_VERSION
      status: "VALIDATED_NO_ACTION"
      decision: NoActionDecisionV2
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
      decision: ProposedTradeDecisionV2
      intent: TradeIntentV2
    }

export type ResearchCycleEvidenceSnapshotReferenceV1 = Readonly<{
  snapshotRef: string
  provider: EvidenceSnapshotMetadata["provider"]
  source: string
  retrievedAt: string
  freshUntil: string
  temporalClass?: "LIVE" | "DELAYED" | "PRIOR_CLOSE"
}>

type ResearchCycleTerminalRecordMetadataV1 = Readonly<{
  evidenceSnapshots: readonly ResearchCycleEvidenceSnapshotReferenceV1[]
  researchInvocation: ResearchInvocationV1
  validatedDecision?: ResearchDecisionV2
  preliminaryResearch?: PreliminaryResearchV2
  researchReport?: ResearchReportV3
}>

export type ResearchCycleTerminalRecordV1 =
  ResearchCycleTerminalRecordMetadataV1 &
    (
      | Readonly<{
          outcome: Extract<ResearchCycleOutcomeV1, { status: "INTENT_DERIVED" }>
          shadowRisk: ShadowRiskResultV1
        }>
      | Readonly<{
          outcome: Exclude<ResearchCycleOutcomeV1, { status: "INTENT_DERIVED" }>
          shadowRisk?: never
        }>
    )

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
