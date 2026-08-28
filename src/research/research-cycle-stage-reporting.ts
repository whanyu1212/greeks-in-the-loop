import type {
  ResearchDecisionV1,
} from "../contracts/research-decision-v1.js"
import type { PreliminaryResearchV1 } from "../contracts/preliminary-research-v1.js"
import type { ResearchReportV2 } from "../contracts/research-report-v2.js"
import type {
  TradeIntentDerivationReason,
  TradeIntentV1,
} from "../contracts/trade-intent-v1.js"
import type {
  ConfirmedOptionQuoteSnapshotV1,
  OptionQuoteConfirmationFailureCode,
} from "../market-data/alpaca-option-quotes.js"
import {
  NOOP_TERMINAL_STAGE_REPORTER,
  type TerminalStageReporter,
  type TerminalStageValue,
} from "../observability/terminal-stage-reporter.js"
import type { ShadowRiskResultV1 } from "../risk/shadow-risk-v1.js"
import type {
  DecisionRejectionIssue,
  ResearchCycleTerminalRecordV1,
} from "./research-cycle-outcome-v1.js"

export type ResearchCycleStageReports = Readonly<{
  researchReportRejected(issues: readonly DecisionRejectionIssue[]): void
  researchReportCompleted(report: ResearchReportV2): void
  preliminaryValidated(research: PreliminaryResearchV1): void
  decisionValidated(decision: ResearchDecisionV1): void
  quotesRejected(
    reasons: readonly OptionQuoteConfirmationFailureCode[],
  ): void
  quotesConfirmed(snapshot: ConfirmedOptionQuoteSnapshotV1): void
  intentRejected(reasons: readonly TradeIntentDerivationReason[]): void
  intentDerived(intent: TradeIntentV1): void
  riskEvaluated(result: ShadowRiskResultV1): void
  ledgerCommitted(record: ResearchCycleTerminalRecordV1): void
  cycleOutcomeRecorded(record: ResearchCycleTerminalRecordV1): void
}>

/**
 * Projects research-cycle values into bounded terminal-stage details.
 *
 * Callers retain control over sequencing; this adapter owns only presentation.
 */
export function createResearchCycleStageReports(
  reporter: TerminalStageReporter = NOOP_TERMINAL_STAGE_REPORTER,
): ResearchCycleStageReports {
  return {
    researchReportRejected(issues) {
      reporter.report("research.report", "REJECTED", {
        issues: issues.map(({ code, path }) => `${code}:${path.join(".")}`),
      })
    },
    researchReportCompleted(report) {
      const result = report.result
      reporter.report("research.report", "COMPLETED", {
        reportVersion: report.reportVersion,
        strategyVersion: result.strategyVersion,
        resultOutcome: result.outcome,
        externalSourceCount: report.analysis.externalContext.length,
        hasCandidate:
          result.outcome === "PROPOSE_TRADE" ||
          (result.outcome === "PRELIMINARY_RESEARCH" &&
            result.candidate !== undefined),
      })
    },
    preliminaryValidated(research) {
      reporter.report("preliminary.validate", "COMPLETED", {
        direction: research.direction,
        targetSessionDate: research.targetSessionDate,
        evidenceCount: research.evidence.length,
        hasCandidate: research.candidate !== undefined,
      })
    },
    decisionValidated(decision) {
      if (decision.outcome === "NO_ACTION") {
        reporter.report("decision.validate", "COMPLETED", {
          outcome: decision.outcome,
          reasonCodes: decision.reasonCodes,
        })
        return
      }
      reporter.report("decision.validate", "COMPLETED", {
        outcome: decision.outcome,
        direction: decision.direction,
        structure: decision.candidate.structure,
        expiration: decision.candidate.expiration,
        evidenceCount: decision.evidence.length,
      })
    },
    quotesRejected(reasons) {
      reporter.report("quotes.confirm", "REJECTED", { reasonCodes: reasons })
    },
    quotesConfirmed(snapshot) {
      reporter.report("quotes.confirm", "COMPLETED", {
        longContractSymbol: snapshot.longQuote.contractSymbol,
        shortContractSymbol: snapshot.shortQuote.contractSymbol,
        source: snapshot.snapshotMetadata.source,
        retrievedAt: snapshot.snapshotMetadata.retrievedAt,
        freshUntil: snapshot.snapshotMetadata.freshUntil,
      })
    },
    intentRejected(reasons) {
      reporter.report("intent.derive", "REJECTED", { reasonCodes: reasons })
    },
    intentDerived(intent) {
      reporter.report("intent.derive", "COMPLETED", {
        direction: intent.direction,
        structure: intent.structure,
        expiration: intent.expiration,
        entryLimitCentsPerShare: intent.entryLimitCentsPerShare,
        maxLossCentsPerContract: intent.maxLossCentsPerContract,
        maxProfitCentsPerContract: intent.maxProfitCentsPerContract,
      })
    },
    riskEvaluated(result) {
      const riskDecision = result.decision
      const reasonCodes = riskDecision.stage === "STATE_CAPTURE_FAILED"
        ? riskDecision.captureReasonCodes
        : riskDecision.stage === "INTENT_REFRESH_FAILED"
          ? riskDecision.derivationReasonCodes
          : riskDecision.evaluation.outcome === "REJECTED"
            ? riskDecision.evaluation.reasonCodes
            : []
      reporter.report(
        "risk.evaluate",
        riskDecision.outcome === "APPROVED" ? "COMPLETED" : "REJECTED",
        {
          evaluationStage: riskDecision.stage,
          outcome: riskDecision.outcome,
          reasonCodes,
          breakerTransitions: result.breakerTransitions.map(
            ({ breaker }) => breaker,
          ),
        },
      )
    },
    ledgerCommitted(record) {
      reporter.report("ledger.commit", "COMPLETED", {
        outcomeStatus: record.outcome.status,
        evidenceSnapshotCount: record.evidenceSnapshots.length,
        shadowRiskRecorded: "shadowRisk" in record,
      })
    },
    cycleOutcomeRecorded(record) {
      const outcome = record.outcome
      const details: Record<string, TerminalStageValue> = {
        outcomeStatus: outcome.status,
      }
      if (outcome.status === "DECISION_REJECTED") {
        details.issues = outcome.issues.map(
          ({ code, path }) => `${code}:${path.join(".")}`,
        )
      } else if (outcome.status === "INTENT_DERIVATION_REJECTED") {
        details.reasonCodes = outcome.reasons
      } else if (outcome.status === "VALIDATED_NO_ACTION") {
        details.reasonCodes = outcome.decision.reasonCodes
      } else if (outcome.status === "PRELIMINARY_RESEARCH_RETAINED") {
        details.direction = outcome.research.direction
      } else {
        details.direction = outcome.decision.direction
        details.riskOutcome = record.shadowRisk!.decision.outcome
      }
      reporter.report(
        "cycle.outcome",
        outcome.status === "INTENT_DERIVED" ||
          outcome.status === "VALIDATED_NO_ACTION" ||
          outcome.status === "PRELIMINARY_RESEARCH_RETAINED"
          ? "COMPLETED"
          : "REJECTED",
        details,
      )
    },
  }
}
