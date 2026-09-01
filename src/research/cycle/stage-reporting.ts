import type {
  ResearchDecisionV4,
} from "../../contracts/research-decision-v4.js"
import type { ResearchReportV7 } from "../../contracts/research-report-v7.js"
import type {
  TradeIntentDerivationReason,
  TradeIntentV3,
} from "../../contracts/trade-intent-v3.js"
import type {
  TradeIntentDerivationReasonV4,
  TradeIntentV4,
} from "../../contracts/trade-intent-v4.js"
import type {
  ConfirmedOptionQuoteSnapshotV2,
  OptionQuoteConfirmationFailureCode,
} from "../../market-data/alpaca-option-quotes.js"
import {
  NOOP_TERMINAL_STAGE_REPORTER,
  type TerminalStageReporter,
  type TerminalStageValue,
} from "../../observability/terminal-stage-reporter.js"
import type { ShadowRiskResultV1 } from "../../risk/shadow-risk-v1.js"
import type {
  DecisionRejectionIssue,
  ResearchCycleTerminalRecordV4,
} from "./outcome.js"

export type ResearchCycleStageReports = Readonly<{
  researchReportRejected(issues: readonly DecisionRejectionIssue[]): void
  researchReportCompleted(report: ResearchReportV7): void
  decisionValidated(decision: ResearchDecisionV4): void
  quotesRejected(
    reasons: readonly OptionQuoteConfirmationFailureCode[],
  ): void
  quotesConfirmed(snapshot: ConfirmedOptionQuoteSnapshotV2): void
  intentRejected(reasons: readonly (
    TradeIntentDerivationReason | TradeIntentDerivationReasonV4
  )[]): void
  intentDerived(intent: TradeIntentV3 | TradeIntentV4): void
  riskEvaluated(result: ShadowRiskResultV1): void
  ledgerCommitted(record: ResearchCycleTerminalRecordV4): void
  cycleOutcomeRecorded(record: ResearchCycleTerminalRecordV4): void
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
        resultOutcome: result.outcome,
        externalSourceCount: report.analysis.externalContext.length,
        proposalCount: result.outcome === "PROPOSE_TRADES"
          ? result.proposals.length
          : 0,
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
        proposalCount: decision.proposals.length,
        candidates: decision.proposals.map(
          ({ candidate }) => candidate.underlying,
        ),
        evidenceCount: decision.proposals.reduce(
          (total, proposal) => total + proposal.evidence.length,
          0,
        ),
      })
    },
    quotesRejected(reasons) {
      reporter.report("quotes.confirm", "REJECTED", { reasonCodes: reasons })
    },
    quotesConfirmed(snapshot) {
      reporter.report("quotes.confirm", "COMPLETED", {
        contractSymbols: snapshot.quotes.map(({ contractSymbol }) =>
          contractSymbol
        ),
        source: snapshot.snapshotMetadata.source,
        retrievedAt: snapshot.snapshotMetadata.retrievedAt,
        freshUntil: snapshot.snapshotMetadata.freshUntil,
      })
    },
    intentRejected(reasons) {
      reporter.report("intent.derive", "REJECTED", { reasonCodes: reasons })
    },
    intentDerived(intent) {
      reporter.report("intent.derive", "COMPLETED", intent.contractVersion === "4.0.0"
        ? {
            direction: intent.direction,
            structure: intent.strategy,
            legCount: intent.legs.length,
            premiumEffect: intent.premiumEffect,
            entryLimitCentsPerShare: intent.entryLimitCentsPerStrategyUnit,
          }
        : {
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
      const spreadGreeks = riskDecision.stage === "EVALUATED"
        ? riskDecision.evaluation.spreadGreeks
        : undefined
      reporter.report(
        "risk.evaluate",
        riskDecision.outcome === "APPROVED" ? "COMPLETED" : "REJECTED",
        {
          evaluationStage: riskDecision.stage,
          outcome: riskDecision.outcome,
          reasonCodes,
          ...(spreadGreeks === undefined
            ? {}
            : {
                netDelta: spreadGreeks.netDelta,
                netGamma: spreadGreeks.netGamma,
                netTheta: spreadGreeks.netTheta,
                netVega: spreadGreeks.netVega,
              }),
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
        shadowRiskCount: record.outcome.status === "PORTFOLIO_EVALUATED"
          ? record.outcome.proposals.filter(
              ({ status }) => status === "RISK_EVALUATED",
            ).length
          : 0,
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
      } else if (outcome.status === "VALIDATED_NO_ACTION") {
        details.reasonCodes = outcome.decision.reasonCodes
      } else {
        details.proposalCount = outcome.proposals.length
        details.selectedCount = outcome.proposals.filter(
          (proposal) => proposal.status === "RISK_EVALUATED" && proposal.selected,
        ).length
      }
      reporter.report(
        "cycle.outcome",
        outcome.status === "PORTFOLIO_EVALUATED" ||
          outcome.status === "VALIDATED_NO_ACTION"
          ? "COMPLETED"
          : "REJECTED",
        details,
      )
    },
  }
}
