import type {
  EvidenceSnapshotMetadata,
  NoActionDecisionV3,
  ProposedPortfolioDecisionV3,
  ResearchDecisionV3,
  ResearchDecisionValidationIssue,
  TradeProposalV3,
} from "../../contracts/research-decision-v3.js"
import type { ResearchReportV6 } from "../../contracts/research-report-v6.js"
import type {
  TradeIntentDerivationReason,
  TradeIntentV3,
} from "../../contracts/trade-intent-v3.js"
import type {
  OptionQuoteConfirmationFailureCode,
} from "../../market-data/alpaca-option-quotes.js"
import type { ShadowRiskResultV1 } from "../../risk/shadow-risk-v1.js"
import type { ResearchInvocationV1 } from "../invocation.js"
import type { SymbolScreenResultV2 } from "../symbol-screen.js"

export const RESEARCH_CYCLE_OUTCOME_VERSION = "3.0.0" as const

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

type ProposalIdentity = Readonly<{
  priority: number
  underlying: string
}>

export type ResearchProposalDispositionV1 = ProposalIdentity &
  (
    | Readonly<{
        status: "DECISION_REJECTED"
        issues: readonly DecisionRejectionIssue[]
      }>
    | Readonly<{
        status: "INTENT_DERIVATION_REJECTED"
        reasons: readonly IntentDerivationRejectionReason[]
      }>
    | Readonly<{
        status: "RISK_EVALUATED"
        proposal: TradeProposalV3
        intent: TradeIntentV3
        shadowRisk: ShadowRiskResultV1
        selected: boolean
      }>
  )

export type ResearchCycleOutcomeV3 =
  | Readonly<{
      outcomeVersion: typeof RESEARCH_CYCLE_OUTCOME_VERSION
      status: "VALIDATED_NO_ACTION"
      decision: NoActionDecisionV3
    }>
  | Readonly<{
      outcomeVersion: typeof RESEARCH_CYCLE_OUTCOME_VERSION
      status: "DECISION_REJECTED"
      issues: readonly DecisionRejectionIssue[]
    }>
  | Readonly<{
      outcomeVersion: typeof RESEARCH_CYCLE_OUTCOME_VERSION
      status: "PORTFOLIO_EVALUATED"
      decision: ProposedPortfolioDecisionV3
      proposals: readonly ResearchProposalDispositionV1[]
    }>

export type ResearchCycleEvidenceSnapshotReferenceV1 = Readonly<{
  snapshotRef: string
  provider: EvidenceSnapshotMetadata["provider"]
  source: string
  retrievedAt: string
  freshUntil: string
  temporalClass?: "LIVE" | "DELAYED" | "PRIOR_CLOSE"
}>

export type ResearchCycleTerminalRecordV3 = Readonly<{
  outcome: ResearchCycleOutcomeV3
  symbolScreen: SymbolScreenResultV2
  evidenceSnapshots: readonly ResearchCycleEvidenceSnapshotReferenceV1[]
  researchInvocation: ResearchInvocationV1
  validatedDecision?: ResearchDecisionV3
  researchReport?: ResearchReportV6
}>

export type ResearchCycleOutcomeSink = Readonly<{
  record(
    record: ResearchCycleTerminalRecordV3,
    signal: AbortSignal,
  ): Promise<void>
}>
