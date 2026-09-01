import type { TradeProposalV3 } from "../contracts/research-decision-v3.js"
import {
  deriveTradeIntentV3,
  type TradeIntentV3,
} from "../contracts/trade-intent-v3.js"
import type { LedgerStore } from "../event-ledger/ledger-store.js"
import { LedgerPersistenceError } from "../event-ledger/research-lifecycle-recorder.js"
import type { ResearchEligibilityV1 } from "../scheduling/research-eligibility.js"
import {
  NOOP_TERMINAL_STAGE_REPORTER,
  type TerminalStageReporter,
} from "../observability/terminal-stage-reporter.js"
import type { RiskStateProvider } from "./alpaca-risk-state-provider.js"
import {
  evaluateTradeIntentRiskV1,
  RISK_EVALUATION_VERSION,
  RISK_RULE_VERSION,
} from "./risk-evaluation-v1.js"
import {
  DURABLE_RISK_CONTROL_STATE_VERSION,
  type DurableRiskControlStateV1,
} from "./risk-state-v1.js"
import {
  SHADOW_RISK_DECISION_VERSION,
  shadowRiskDecisionV1Schema,
  type RiskBreakerTransitionV1,
  type ShadowRiskResultV1,
  type ShadowRiskStateProvenanceV1,
} from "./shadow-risk-v1.js"

export const SHADOW_RISK_QUOTE_SNAPSHOT_REF =
  "alpaca-shadow-risk-quotes-v1" as const

export type DurableRiskControlStateLoader = Readonly<{
  load(tradingDate: string, signal: AbortSignal): Promise<DurableRiskControlStateV1>
}>

export type ShadowRiskEvaluator = Readonly<{
  evaluate(input: Readonly<{
    decision: TradeProposalV3
    sourceIntent: TradeIntentV3
    captureEligibility: ResearchEligibilityV1 & Readonly<{
      sessionDate: string
      tradeIntentWindow: NonNullable<ResearchEligibilityV1["tradeIntentWindow"]>
    }>
    getEvaluationEligibility: () => ResearchEligibilityV1
    signal: AbortSignal
    stageReporter?: TerminalStageReporter
  }>): Promise<ShadowRiskResultV1>
}>

const initialDurableControl = (
  tradingDate: string,
): DurableRiskControlStateV1 => ({
  stateVersion: DURABLE_RISK_CONTROL_STATE_VERSION,
  tradingDate,
  entriesSubmittedToday: 0,
  dailyBreakerActive: false,
  competitionBreakerActive: false,
})

export function createLedgerDurableRiskControlStateLoader(
  store: LedgerStore,
): DurableRiskControlStateLoader {
  return {
    async load(tradingDate, signal) {
      signal.throwIfAborted()
      let dailyBreakerActive = false
      let competitionBreakerActive = false
      let afterSequence = 0
      while (true) {
        let page: Awaited<ReturnType<LedgerStore["list"]>>
        try {
          page = await store.list({
            afterSequence,
            direction: "ASC",
            eventTypes: ["RISK_BREAKER_LATCHED"],
            limit: 1_000,
          })
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? error
          if (error instanceof LedgerPersistenceError) throw error
          throw new LedgerPersistenceError("durable risk-control query", error)
        }
        for (const event of page) {
          if (event.eventType !== "RISK_BREAKER_LATCHED") continue
          if (
            event.payload.breaker === "DAILY" &&
            event.payload.tradingDate === tradingDate
          ) {
            dailyBreakerActive = true
          }
          if (
            event.payload.breaker === "COMPETITION" &&
            event.payload.tradingDate <= tradingDate
          ) {
            competitionBreakerActive = true
          }
        }
        if (page.length < 1_000) break
        afterSequence = page.at(-1)?.sequence ?? afterSequence
        signal.throwIfAborted()
      }
      return {
        ...initialDurableControl(tradingDate),
        dailyBreakerActive,
        competitionBreakerActive,
      }
    },
  }
}

const provenanceFor = (
  snapshot: Awaited<ReturnType<RiskStateProvider["capture"]>> & {
    success: true
  },
): ShadowRiskStateProvenanceV1 => ({
  capturedAt: snapshot.snapshot.evaluatedAt,
  accountObservedAt: snapshot.snapshot.account.observedAt,
  portfolioObservedAt: snapshot.snapshot.portfolio.observedAt,
  contractsObservedAt: snapshot.snapshot.contracts.observedAt,
  quoteSnapshot: {
    provider: "ALPACA",
    source: snapshot.snapshot.quoteSnapshot.snapshotMetadata.source,
    retrievedAt: snapshot.snapshot.quoteSnapshot.snapshotMetadata.retrievedAt,
    freshUntil: snapshot.snapshot.quoteSnapshot.snapshotMetadata.freshUntil,
  },
  reconciliationReasonCodes: [
    ...snapshot.snapshot.reconciliationReasonCodes,
  ],
})

const breakerTransitionsFor = (
  durable: DurableRiskControlStateV1,
  portfolio: Readonly<{
    dailyBreakerActive: boolean
    competitionBreakerActive: boolean
    observedAt: string
  }>,
): readonly RiskBreakerTransitionV1[] => {
  const transitions: RiskBreakerTransitionV1[] = []
  if (!durable.dailyBreakerActive && portfolio.dailyBreakerActive) {
    transitions.push({
      stateVersion: DURABLE_RISK_CONTROL_STATE_VERSION,
      tradingDate: durable.tradingDate,
      observedAt: portfolio.observedAt,
      breaker: "DAILY",
    })
  }
  if (!durable.competitionBreakerActive && portfolio.competitionBreakerActive) {
    transitions.push({
      stateVersion: DURABLE_RISK_CONTROL_STATE_VERSION,
      tradingDate: durable.tradingDate,
      observedAt: portfolio.observedAt,
      breaker: "COMPETITION",
    })
  }
  return transitions
}

export function createShadowRiskEvaluator(options: Readonly<{
  provider: RiskStateProvider
  durableControl: DurableRiskControlStateLoader
  deriveIntent?: typeof deriveTradeIntentV3
  evaluateRisk?: typeof evaluateTradeIntentRiskV1
}>): ShadowRiskEvaluator {
  const deriveIntent = options.deriveIntent ?? deriveTradeIntentV3
  const evaluateRisk = options.evaluateRisk ?? evaluateTradeIntentRiskV1
  return {
    async evaluate(input) {
      input.signal.throwIfAborted()
      const stageReporter =
        input.stageReporter ?? NOOP_TERMINAL_STAGE_REPORTER
      const { sessionDate, tradeIntentWindow } = input.captureEligibility
      const durableControl = await options.durableControl.load(
        sessionDate,
        input.signal,
      )
      stageReporter.report("risk.durable_state", "COMPLETED", {
        tradingDate: durableControl.tradingDate,
        dailyBreakerActive: durableControl.dailyBreakerActive,
        competitionBreakerActive: durableControl.competitionBreakerActive,
        entriesSubmittedToday: durableControl.entriesSubmittedToday,
      })
      const capture = await options.provider.capture({
        sessionDate,
        slotStartedAt: tradeIntentWindow.slotStartedAt,
        longContractSymbol: input.sourceIntent.longContractSymbol,
        shortContractSymbol: input.sourceIntent.shortContractSymbol,
        durableControl,
        signal: input.signal,
      })
      input.signal.throwIfAborted()
      if (!capture.success) {
        stageReporter.report("risk.state_capture", "REJECTED", {
          reasonCodes: capture.reasons,
        })
        return {
          decision: shadowRiskDecisionV1Schema.parse({
            decisionVersion: SHADOW_RISK_DECISION_VERSION,
            mode: "SHADOW",
            evaluationVersion: RISK_EVALUATION_VERSION,
            ruleVersion: RISK_RULE_VERSION,
            stage: "STATE_CAPTURE_FAILED",
            outcome: "REJECTED",
            evaluatedAt: null,
            captureReasonCodes: capture.reasons,
          }),
          breakerTransitions: [],
        }
      }

      stageReporter.report("risk.state_capture", "COMPLETED", {
        evaluatedAt: capture.snapshot.evaluatedAt,
        accountObservedAt: capture.snapshot.account.observedAt,
        portfolioObservedAt: capture.snapshot.portfolio.observedAt,
        contractsObservedAt: capture.snapshot.contracts.observedAt,
        reconciliationReasonCodes: capture.snapshot.reconciliationReasonCodes,
      })

      const stateProvenance = provenanceFor(capture)
      const breakerTransitions = breakerTransitionsFor(
        durableControl,
        capture.snapshot.portfolio,
      )
      const refreshed = deriveIntent(input.decision, {
        quoteSnapshotRef: SHADOW_RISK_QUOTE_SNAPSHOT_REF,
        evaluatedAt: capture.snapshot.evaluatedAt,
        longQuote: capture.snapshot.quoteSnapshot.longQuote,
        shortQuote: capture.snapshot.quoteSnapshot.shortQuote,
      })
      input.signal.throwIfAborted()
      if (!refreshed.success) {
        stageReporter.report("risk.intent_refresh", "REJECTED", {
          reasonCodes: refreshed.reasons,
        })
        return {
          decision: shadowRiskDecisionV1Schema.parse({
            decisionVersion: SHADOW_RISK_DECISION_VERSION,
            mode: "SHADOW",
            evaluationVersion: RISK_EVALUATION_VERSION,
            ruleVersion: RISK_RULE_VERSION,
            stage: "INTENT_REFRESH_FAILED",
            outcome: "REJECTED",
            evaluatedAt: capture.snapshot.evaluatedAt,
            derivationReasonCodes: refreshed.reasons,
            stateProvenance,
          }),
          breakerTransitions,
        }
      }

      stageReporter.report("risk.intent_refresh", "COMPLETED", {
        evaluatedAt: refreshed.intent.evaluatedAt,
        entryLimitCentsPerShare: refreshed.intent.entryLimitCentsPerShare,
        maxLossCentsPerContract: refreshed.intent.maxLossCentsPerContract,
      })

      const evaluation = evaluateRisk({
        intent: refreshed.intent,
        context: {
          provenance: "APPLICATION_VERIFIED",
          eligibility: input.getEvaluationEligibility(),
          account: capture.snapshot.account,
          portfolio: capture.snapshot.portfolio,
          contracts: capture.snapshot.contracts,
        },
      })
      return {
        decision: shadowRiskDecisionV1Schema.parse({
          decisionVersion: SHADOW_RISK_DECISION_VERSION,
          mode: "SHADOW",
          evaluationVersion: evaluation.evaluationVersion,
          ruleVersion: evaluation.ruleVersion,
          stage: "EVALUATED",
          outcome: evaluation.outcome,
          evaluatedIntent: refreshed.intent,
          stateProvenance,
          evaluation,
        }),
        breakerTransitions,
      }
    },
  }
}
