import { describe, expect, it, vi } from "vitest"

import type { TradeProposalV4 } from "../src/contracts/research-decision-v4.js"
import { deriveTradeIntentV4 } from "../src/contracts/trade-intent-v4.js"
import type { RiskStateProvider } from "../src/risk/alpaca-risk-state-provider.js"
import type { StoredLedgerEventV4 } from "../src/event-ledger/ledger-event-v1.js"
import type { LedgerStore } from "../src/event-ledger/ledger-store.js"
import { LedgerPersistenceError } from "../src/event-ledger/research-lifecycle-recorder.js"
import { buildRiskReportV1 } from "../src/risk/risk-report-v1.js"
import {
  createLedgerDurableRiskControlStateLoader,
  createShadowRiskEvaluator,
  SHADOW_RISK_QUOTE_SNAPSHOT_REF,
} from "../src/risk/shadow-risk-service.js"

const signal = new AbortController().signal
const sessionDate = "2026-08-27"
const slotStartedAt = "2026-08-27T14:30:00.000Z"
const evaluatedAt = "2026-08-27T14:30:30.000Z"
const longSymbol = "SPY260918C00600000"
const shortSymbol = "SPY260918C00605000"

const decision: TradeProposalV4 = {
  priority: 1,
  direction: "BULLISH",
  thesis: "Daily and intraday direction agree.",
  candidate: {
    underlying: "SPY",
    strategy: "BULL_CALL_SPREAD",
    legs: [
      {
        contractSymbol: longSymbol,
        positionIntent: "BUY_TO_OPEN",
        ratioQuantity: 1,
      },
      {
        contractSymbol: shortSymbol,
        positionIntent: "SELL_TO_OPEN",
        ratioQuantity: 1,
      },
    ],
  },
  invalidation: ["Reject if refreshed evidence changes the candidate."],
  evidence: [{
    claimId: "quote-fact",
    kind: "SOURCED_FACT",
    claim: "The exact proposed legs were confirmed.",
    snapshotRef: "alpaca-proposal-quotes-v2-SPY",
  }],
}

const quotes = (timestamp: string) => ({
  longQuote: {
    contractSymbol: longSymbol,
    feed: "INDICATIVE" as const,
    bidCentsPerShare: 300,
    askCentsPerShare: 310,
    providerTimestamp: timestamp,
  },
  shortQuote: {
    contractSymbol: shortSymbol,
    feed: "INDICATIVE" as const,
    bidCentsPerShare: 100,
    askCentsPerShare: 110,
    providerTimestamp: timestamp,
  },
})

const sourceIntent = (() => {
  const result = deriveTradeIntentV4(decision, {
    quoteSnapshotRef: "alpaca-proposal-quotes-v2-SPY",
    evaluatedAt: "2026-08-27T14:30:10.000Z",
    quotes: Object.values(quotes("2026-08-27T14:30:00.000000000Z")),
  })
  if (!result.success) throw new Error("Test intent could not be derived")
  return result.intent
})()

const eligibility = {
  evaluatedAt,
  sessionDate,
  researchEligible: true,
  tradeIntentEligible: true,
  tradeIntentWindow: {
    slotStartedAt,
    deadline: "2026-08-27T14:35:00.000Z",
  },
  previousSessionDates: ["2026-08-25", "2026-08-26"],
} as const

const snapshot = (dailyBreakerActive = false) => ({
  snapshotVersion: "2.0.0" as const,
  evaluatedAt,
  quoteSnapshot: {
    snapshotVersion: "2.0.0" as const,
    evaluatedAt,
    snapshotMetadata: {
      provider: "ALPACA" as const,
      source: "options-snapshots-indicative",
      retrievedAt: evaluatedAt,
      freshUntil: "2026-08-27T14:31:00.000Z",
    },
    quotes: Object.values(quotes("2026-08-27T14:30:20.000000000Z")),
  },
  account: {
    snapshotVersion: "2.0.0" as const,
    observedAt: evaluatedAt,
    status: "ACTIVE" as const,
    tradingRestricted: false,
    optionsApprovedLevel: 3,
    optionsTradingLevel: 3,
    multilegOptionsApproved: true,
    buyingPowerCents: 20_000_000,
    cashCents: 5_000_000,
    equityCents: 10_000_000,
    lastEquityCents: 10_000_000,
  },
  positions: [],
  candidateCollateral: {
    underlying: "SPY",
    longUnderlyingShares: 0,
    cashAvailableCents: 5_000_000,
    requiredLongSharesPerUnit: 0,
    requiredCashCentsPerUnit: 0,
    maxUnitsFromShares: null,
    maxUnitsFromCash: null,
  },
  portfolio: {
    observedAt: evaluatedAt,
    consistent: true,
    openStrategyPositionCount: 0,
    pendingEntryCount: 0,
    entriesSubmittedToday: 0,
    dailyBreakerActive,
    competitionBreakerActive: false,
  },
  contracts: {
    snapshotVersion: "2.0.0" as const,
    slotStartedAt,
    observedAt: evaluatedAt,
    legs: [
      {
        contractSymbol: longSymbol,
        positionIntent: "BUY_TO_OPEN" as const,
        ratioQuantity: 1,
        active: true,
        tradable: true,
        exerciseStyle: "AMERICAN" as const,
        multiplier: 100,
        delta: 0.5,
        impliedVolatility: 0.2,
        gamma: 0.01,
        theta: -0.02,
        vega: 0.05,
        volume: 100,
        volumeDate: sessionDate,
        openInterest: 500,
        openInterestDate: "2026-08-26",
      },
      {
        contractSymbol: shortSymbol,
        positionIntent: "SELL_TO_OPEN" as const,
        ratioQuantity: 1,
        active: true,
        tradable: true,
        exerciseStyle: "AMERICAN" as const,
        multiplier: 100,
        delta: 0.3,
        impliedVolatility: 0.2,
        gamma: 0.01,
        theta: -0.02,
        vega: 0.05,
        volume: 100,
        volumeDate: sessionDate,
        openInterest: 500,
        openInterestDate: "2026-08-26",
      },
    ],
  },
  reconciliationReasonCodes: [],
})

const durableControl = {
  load: vi.fn(async () => ({
    stateVersion: "1.0.0" as const,
    tradingDate: sessionDate,
    entriesSubmittedToday: 0,
    dailyBreakerActive: false,
    competitionBreakerActive: false,
  })),
}

const evaluate = (
  provider: RiskStateProvider,
  proposal: TradeProposalV4 = decision,
) =>
  createShadowRiskEvaluator({ provider, durableControl }).evaluate({
    decision: proposal,
    sourceIntent,
    captureEligibility: eligibility,
    getEvaluationEligibility: () => eligibility,
    signal,
  })

describe("shadow risk evaluator", () => {
  it("treats durable-control ledger read failures as fatal persistence errors", async () => {
    const cause = new Error("ledger unavailable")
    const store = {
      list: vi.fn(async () => { throw cause }),
    } as unknown as LedgerStore

    const failure = await createLedgerDurableRiskControlStateLoader(store)
      .load(sessionDate, signal)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(LedgerPersistenceError)
    expect(failure).toMatchObject({
      message: "Ledger durable risk-control query failed",
      cause,
    })
  })

  it("refreshes quotes and approves an eligible intent without broker mutation", async () => {
    const capture = vi.fn<RiskStateProvider["capture"]>(async () => ({
      success: true,
      snapshot: snapshot(),
    }))
    const result = await evaluate({ capture })

    expect(capture).toHaveBeenCalledOnce()
    expect(result.decision).toMatchObject({
      mode: "SHADOW",
      stage: "EVALUATED",
      outcome: "APPROVED",
      ruleVersion: "2.0.0",
      evaluatedIntent: {
        quoteSnapshotRef: SHADOW_RISK_QUOTE_SNAPSHOT_REF,
        evaluatedAt,
      },
      evaluation: {
        aggregateGreeks: {
          calculation: "POSITION_WEIGHTED_SUM",
          netDelta: 0.2,
          netGamma: 0,
          netTheta: 0,
          netVega: 0,
        },
        strategyEconomics: {
          strategy: "BULL_CALL_SPREAD",
          maxLossCents: 21_000,
          maxProfitCents: 29_000,
        },
      },
    })
    expect(result.breakerTransitions).toEqual([])
  })

  it("bounds net delta on a structure whose thesis is not directional", async () => {
    const putSymbol = "SPY260918P00600000"
    const straddleQuotes = (timestamp: string) => ({
      longQuote: {
        contractSymbol: longSymbol,
        feed: "INDICATIVE" as const,
        bidCentsPerShare: 300,
        askCentsPerShare: 310,
        providerTimestamp: timestamp,
      },
      putQuote: {
        contractSymbol: putSymbol,
        feed: "INDICATIVE" as const,
        bidCentsPerShare: 290,
        askCentsPerShare: 300,
        providerTimestamp: timestamp,
      },
    })
    const straddle: TradeProposalV4 = {
      ...decision,
      direction: "VOLATILITY",
      candidate: {
        underlying: "SPY",
        strategy: "LONG_STRADDLE",
        legs: [
          { contractSymbol: longSymbol, positionIntent: "BUY_TO_OPEN", ratioQuantity: 1 },
          { contractSymbol: putSymbol, positionIntent: "BUY_TO_OPEN", ratioQuantity: 1 },
        ],
      },
    }
    const straddleIntent = (() => {
      const derived = deriveTradeIntentV4(straddle, {
        quoteSnapshotRef: "alpaca-proposal-quotes-v2-SPY",
        evaluatedAt: "2026-08-27T14:30:10.000Z",
        quotes: Object.values(straddleQuotes("2026-08-27T14:30:00.000000000Z")),
      })
      if (!derived.success) throw new Error("Straddle intent could not be derived")
      return derived.intent
    })()
    // A real straddle carries near-zero net delta. These legs sum to 0.25,
    // which is a directional bet wearing a volatility label; nothing rejected
    // it before, because the directional band applies only to BULLISH and
    // BEARISH intents and the screen never tested direction for this outlook.
    const straddleSnapshot = () => {
      const base = snapshot()
      return {
        ...base,
        quoteSnapshot: {
          ...base.quoteSnapshot,
          quotes: Object.values(straddleQuotes("2026-08-27T14:30:20.000000000Z")),
        },
        contracts: {
          ...base.contracts,
          legs: [
            { ...base.contracts.legs[0]!, delta: 0.55 },
            {
              ...base.contracts.legs[1]!,
              contractSymbol: putSymbol,
              positionIntent: "BUY_TO_OPEN" as const,
              delta: -0.3,
            },
          ],
        },
      }
    }
    const rejectedStraddle = await createShadowRiskEvaluator({
      provider: { capture: vi.fn(async () => ({
        success: true as const,
        snapshot: straddleSnapshot(),
      })) },
      durableControl,
    }).evaluate({
      decision: straddle,
      sourceIntent: straddleIntent,
      captureEligibility: eligibility,
      getEvaluationEligibility: () => eligibility,
      signal,
    })

    expect(rejectedStraddle.decision).toMatchObject({
      stage: "EVALUATED",
      outcome: "REJECTED",
      evaluation: {
        reasonCodes: expect.arrayContaining(["SPREAD_GREEKS_INELIGIBLE"]),
      },
    })
  })

  it("keeps the legacy directional band untouched", async () => {
    const approved = await evaluate({
      capture: vi.fn<RiskStateProvider["capture"]>(async () => ({
        success: true,
        snapshot: snapshot(),
      })),
    })

    expect(approved.decision).toMatchObject({ outcome: "APPROVED" })
  })

  it("rejects when the captured Alpaca option level cannot open the strategy", async () => {
    const captured = snapshot()
    const result = await evaluate({
      capture: vi.fn(async () => ({
        success: true as const,
        snapshot: {
          ...captured,
          account: {
            ...captured.account,
            optionsApprovedLevel: 2,
            optionsTradingLevel: 2,
            multilegOptionsApproved: false,
          },
        },
      })),
    })

    expect(result.decision).toMatchObject({
      stage: "EVALUATED",
      outcome: "REJECTED",
      evaluation: {
        reasonCodes: expect.arrayContaining(["OPTIONS_APPROVAL_INSUFFICIENT"]),
      },
    })
  })

  it("fails closed on capture errors and records newly observed breaker latches", async () => {
    const failed = await evaluate({
      capture: vi.fn(async () => ({
        success: false as const,
        reasons: ["ACCOUNT_REQUEST_FAILED" as const],
      })),
    })
    expect(failed.decision).toMatchObject({
      stage: "STATE_CAPTURE_FAILED",
      outcome: "REJECTED",
      captureReasonCodes: ["ACCOUNT_REQUEST_FAILED"],
    })

    const latched = await evaluate({
      capture: vi.fn(async () => ({ success: true as const, snapshot: snapshot(true) })),
    })
    expect(latched.decision.outcome).toBe("REJECTED")
    expect(latched.breakerTransitions).toEqual([
      {
        stateVersion: "1.0.0",
        tradingDate: sessionDate,
        observedAt: evaluatedAt,
        breaker: "DAILY",
      },
    ])
  })

  it("builds a date-filtered read-only ledger report", () => {
    const events = [
      {
        eventId: "cycle-start",
        eventVersion: "4.0.0",
        eventType: "RESEARCH_CYCLE_STARTED",
        occurredAt: evaluatedAt,
        recordedAt: evaluatedAt,
        sequence: 1,
        correlationId: "correlation-1",
        cycleId: "cycle-1",
        payload: {
          cycleNumber: 1,
          sessionDate,
          initialEligibility: eligibility,
        },
      },
      {
        eventId: "risk-1",
        eventVersion: "4.0.0",
        eventType: "RISK_SHADOW_DECISION_RECORDED",
        occurredAt: evaluatedAt,
        recordedAt: evaluatedAt,
        sequence: 2,
        correlationId: "correlation-1",
        causationEventId: "intent-1",
        cycleId: "cycle-1",
        payload: {
          decision: {
            decisionVersion: "1.0.0",
            mode: "SHADOW",
            evaluationVersion: "1.0.0",
            ruleVersion: "1.0.0",
            stage: "STATE_CAPTURE_FAILED",
            outcome: "REJECTED",
            evaluatedAt: null,
            captureReasonCodes: ["ACCOUNT_REQUEST_FAILED"],
          },
        },
      },
    ] as StoredLedgerEventV4[]

    expect(buildRiskReportV1(events, sessionDate)).toMatchObject({
      tradingDate: sessionDate,
      decisionCount: 1,
      captureRejectedCount: 1,
      reasonCounts: { ACCOUNT_REQUEST_FAILED: 1 },
    })
    expect(buildRiskReportV1(events, "2026-08-28").decisionCount).toBe(0)
  })
})
