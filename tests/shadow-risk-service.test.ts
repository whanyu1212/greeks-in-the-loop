import { describe, expect, it, vi } from "vitest"

import type { ProposedTradeDecisionV2 } from "../src/contracts/research-decision-v2.js"
import { deriveTradeIntentV2 } from "../src/contracts/trade-intent-v2.js"
import type { RiskStateProvider } from "../src/risk/alpaca-risk-state-provider.js"
import type { StoredLedgerEventV2 } from "../src/event-ledger/ledger-event-v1.js"
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

const decision: ProposedTradeDecisionV2 = {
  contractVersion: "2.0.0",
  outcome: "PROPOSE_TRADE",
  direction: "BULLISH",
  thesis: "Daily and intraday direction agree.",
  candidate: {
    underlying: "SPY",
    structure: "BULL_CALL_SPREAD",
    expiration: "2026-09-18",
    longLeg: { contractSymbol: longSymbol, strike: 600 },
    shortLeg: { contractSymbol: shortSymbol, strike: 605 },
  },
  invalidation: ["Reject if refreshed evidence changes the candidate."],
  evidence: [{
    claimId: "quote-fact",
    kind: "SOURCED_FACT",
    claim: "The exact proposed legs were confirmed.",
    snapshotRef: "alpaca-proposal-quotes-v1",
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
  const result = deriveTradeIntentV2(decision, {
    quoteSnapshotRef: "alpaca-proposal-quotes-v1",
    evaluatedAt: "2026-08-27T14:30:10.000Z",
    ...quotes("2026-08-27T14:30:00.000000000Z"),
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
  evaluatedAt,
  quoteSnapshot: {
    evaluatedAt,
    snapshotMetadata: {
      provider: "ALPACA" as const,
      source: "options-snapshots-indicative",
      retrievedAt: evaluatedAt,
      freshUntil: "2026-08-27T14:31:00.000Z",
    },
    ...quotes("2026-08-27T14:30:20.000000000Z"),
  },
  account: {
    observedAt: evaluatedAt,
    status: "ACTIVE" as const,
    tradingRestricted: false,
    multilegOptionsApproved: true,
    buyingPowerCents: 20_000_000,
    equityCents: 10_000_000,
    lastEquityCents: 10_000_000,
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
    slotStartedAt,
    observedAt: evaluatedAt,
    legs: [
      {
        role: "LONG" as const,
        contractSymbol: longSymbol,
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
        role: "SHORT" as const,
        contractSymbol: shortSymbol,
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

const evaluate = (provider: RiskStateProvider) =>
  createShadowRiskEvaluator({ provider, durableControl }).evaluate({
    decision,
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
      evaluatedIntent: {
        quoteSnapshotRef: SHADOW_RISK_QUOTE_SNAPSHOT_REF,
        evaluatedAt,
      },
    })
    expect(result.breakerTransitions).toEqual([])
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
        eventVersion: "2.0.0",
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
        eventVersion: "2.0.0",
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
    ] as StoredLedgerEventV2[]

    expect(buildRiskReportV1(events, sessionDate)).toMatchObject({
      tradingDate: sessionDate,
      decisionCount: 1,
      captureRejectedCount: 1,
      reasonCounts: { ACCOUNT_REQUEST_FAILED: 1 },
    })
    expect(buildRiskReportV1(events, "2026-08-28").decisionCount).toBe(0)
  })
})
