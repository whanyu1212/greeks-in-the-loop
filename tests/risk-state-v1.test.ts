import { describe, expect, it } from "vitest"

import {
  DURABLE_RISK_CONTROL_STATE_VERSION,
  reconcileBrokerPortfolioV1,
  type NormalizedBrokerOrderV1,
  type NormalizedBrokerPositionV1,
} from "../src/risk/risk-state-v1.js"

const observedAt = "2026-08-27T14:30:30.000Z"
const durableControl = {
  stateVersion: DURABLE_RISK_CONTROL_STATE_VERSION,
  tradingDate: "2026-08-27",
  entriesSubmittedToday: 0,
  dailyBreakerActive: false,
  competitionBreakerActive: false,
} as const
const account = {
  equityCents: 10_000_000,
  lastEquityCents: 10_000_000,
}
const longSymbol = "SPY260918C00600000"
const shortSymbol = "SPY260918C00605000"

const position = (
  symbol: string,
  signedQuantity: number,
): NormalizedBrokerPositionV1 => ({
  assetClass: "us_option",
  symbol,
  signedQuantity,
})

const order = (overrides: Partial<NormalizedBrokerOrderV1> = {}): NormalizedBrokerOrderV1 => ({
  id: "order-1",
  assetClass: "us_option",
  submittedAt: "2026-08-27T14:29:00.000Z",
  status: "accepted",
  orderClass: "mleg",
  orderType: "limit",
  timeInForce: "day",
  quantity: 1,
  legs: [
    { symbol: longSymbol, ratioQuantity: 1, positionIntent: "BUY_TO_OPEN" },
    { symbol: shortSymbol, ratioQuantity: 1, positionIntent: "SELL_TO_OPEN" },
  ],
  ...overrides,
})

const closingOrder = (overrides: Partial<NormalizedBrokerOrderV1> = {}) =>
  order({
    id: "closing-order",
    status: "filled",
    legs: [
      { symbol: longSymbol, ratioQuantity: 1, positionIntent: "SELL_TO_CLOSE" },
      { symbol: shortSymbol, ratioQuantity: 1, positionIntent: "BUY_TO_CLOSE" },
    ],
    ...overrides,
  })

const reconcile = (overrides: Record<string, unknown> = {}) =>
  reconcileBrokerPortfolioV1({
    observedAt,
    sessionDate: "2026-08-27",
    durableControl,
    account,
    initialBrokerState: { positions: [], openOrders: [] },
    finalBrokerState: { positions: [], openOrders: [] },
    submittedOrders: [],
    ...overrides,
  })

describe("risk-state reconciliation v1", () => {
  it("produces a consistent flat portfolio", () => {
    expect(reconcile()).toEqual({
      success: true,
      portfolio: {
        observedAt,
        consistent: true,
        openStrategyPositionCount: 0,
        pendingEntryCount: 0,
        entriesSubmittedToday: 0,
        dailyBreakerActive: false,
        competitionBreakerActive: false,
      },
      reasonCodes: [],
    })
  })

  it("recognizes one exact supported open spread", () => {
    const positions = [position(longSymbol, 1), position(shortSymbol, -1)]
    const result = reconcile({
      initialBrokerState: { positions, openOrders: [] },
      finalBrokerState: { positions, openOrders: [] },
    })
    expect(result.success && result.portfolio).toMatchObject({
      consistent: true,
      openStrategyPositionCount: 1,
    })
  })

  it("recognizes a pending entry and consumes terminal same-day attempts", () => {
    const pending = order()
    const result = reconcile({
      initialBrokerState: { positions: [], openOrders: [pending] },
      finalBrokerState: { positions: [], openOrders: [pending] },
      submittedOrders: [order({ status: "rejected" })],
    })
    expect(result.success && result.portfolio).toMatchObject({
      consistent: true,
      pendingEntryCount: 1,
      entriesSubmittedToday: 1,
    })
  })

  it("fails closed when broker activity changes during capture", () => {
    const result = reconcile({
      brokerStateChangedDuringCapture: true,
      submittedOrders: [order({ status: "rejected" })],
    })
    expect(result.success && result.portfolio).toMatchObject({
      consistent: false,
      entriesSubmittedToday: 1,
    })
    expect(result.success && result.reasonCodes).toEqual([
      "BROKER_STATE_CHANGED",
    ])
  })

  it("does not count recognized closing-only option orders as same-day entries", () => {
    const result = reconcile({
      submittedOrders: [closingOrder()],
    })
    expect(result.success && result.portfolio).toMatchObject({
      consistent: true,
      entriesSubmittedToday: 0,
    })
  })

  it("fails closed for unmatched, extra, or unrelated exposure", () => {
    const positions = [
      position(longSymbol, 1),
      { assetClass: "us_equity", symbol: "SPY", signedQuantity: 1 },
    ]
    const unknownOrder = order({ orderClass: "simple", legs: [] })
    const result = reconcile({
      initialBrokerState: { positions, openOrders: [unknownOrder] },
      finalBrokerState: { positions, openOrders: [unknownOrder] },
    })
    expect(result.success && result.portfolio.consistent).toBe(false)
    expect(result.success && result.reasonCodes).toEqual([
      "UNKNOWN_POSITION",
      "UNMATCHED_OPTION_POSITION",
      "UNKNOWN_OPEN_ORDER",
      "UNMATCHED_PENDING_ENTRY",
    ])
  })

  it("preserves unrelated fractional exposure as inconsistent state", () => {
    const positions = [
      { assetClass: "us_equity", symbol: "SPY", signedQuantity: 0.25 },
    ]
    const result = reconcile({
      initialBrokerState: { positions, openOrders: [] },
      finalBrokerState: { positions, openOrders: [] },
    })
    expect(result.success && result.portfolio).toMatchObject({
      consistent: false,
      openStrategyPositionCount: 0,
    })
    expect(result.success && result.reasonCodes).toEqual(["UNKNOWN_POSITION"])
  })

  it("detects broker state changes and duplicate records", () => {
    const duplicate = position(longSymbol, 1)
    const result = reconcile({
      initialBrokerState: { positions: [], openOrders: [] },
      finalBrokerState: { positions: [duplicate, duplicate], openOrders: [] },
    })
    expect(result.success && result.reasonCodes).toEqual([
      "BROKER_STATE_CHANGED",
      "DUPLICATE_BROKER_RECORD",
      "UNMATCHED_OPTION_POSITION",
    ])
  })

  it("combines durable latches with inclusive equity thresholds", () => {
    const result = reconcile({
      durableControl: { ...durableControl, entriesSubmittedToday: 1 },
      account: {
        equityCents: 9_250_000,
        lastEquityCents: 9_400_000,
      },
    })
    expect(result.success && result.portfolio).toMatchObject({
      entriesSubmittedToday: 1,
      dailyBreakerActive: true,
      competitionBreakerActive: true,
    })
  })

  it("rejects durable state from another trading date", () => {
    expect(reconcile({
      durableControl: { ...durableControl, tradingDate: "2026-08-26" },
    })).toEqual({
      success: false,
      reasons: ["RECONCILIATION_INPUT_INVALID"],
    })
  })
})
