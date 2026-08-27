import type { ProposedTradeDecisionV1 } from "../contracts/research-decision-v1.js"
import {
  deriveTradeIntentV1,
  type TradeIntentV1,
} from "../contracts/trade-intent-v1.js"
import type { LedgerStore } from "../event-ledger/ledger-store.js"
import { LedgerPersistenceError } from "../event-ledger/research-lifecycle-recorder.js"
import type { ResearchEligibilityV1 } from "../scheduling/research-eligibility.js"
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
    decision: ProposedTradeDecisionV1
    sourceIntent: TradeIntentV1
    captureEligibility: ResearchEligibilityV1 & Readonly<{
      sessionDate: string
      tradeIntentWindow: NonNullable<ResearchEligibilityV1["tradeIntentWindow"]>
    }>
    getEvaluationEligibility: () => ResearchEligibilityV1
    signal: AbortSignal
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
  deriveIntent?: typeof deriveTradeIntentV1
  evaluateRisk?: typeof evaluateTradeIntentRiskV1
}>): ShadowRiskEvaluator {
  const deriveIntent = options.deriveIntent ?? deriveTradeIntentV1
  const evaluateRisk = options.evaluateRisk ?? evaluateTradeIntentRiskV1
  return {
    async evaluate(input) {
      input.signal.throwIfAborted()
      const { sessionDate, tradeIntentWindow } = input.captureEligibility
      const durableControl = await options.durableControl.load(
        sessionDate,
        input.signal,
      )
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
