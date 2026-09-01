import { describe, expect, it } from "vitest"

import {
  OPTION_TRADE_DIRECTION_DICTIONARY,
  optionTradingDecisionV1Schema,
  optionTradingOrderLegV1Schema,
} from "../src/contracts/research-decision-v2.js"

const directionCases = [
  ["BUY_CALL", "LONG_CALL", "SPY260918C00650000"],
  ["BUY_PUT", "LONG_PUT", "SPY260918P00650000"],
  ["SELL_CALL", "SHORT_CALL", "SPY260918C00650000"],
  ["SELL_PUT", "SHORT_PUT", "SPY260918P00650000"],
] as const

const evidence = [
  {
    claimId: "fact-1",
    kind: "SOURCED_FACT",
    claim: "The selected option contract was present in the retained snapshot.",
    snapshotRef: "alpaca-options-1",
  },
] as const

const order = (
  direction: (typeof directionCases)[number][0],
  contractSymbol: string,
) => ({
  legId: "entry-1",
  ticker: "SPY" as const,
  direction,
  positionEffect: "OPEN" as const,
  contractSymbol,
  expiration: "2026-09-18",
  strike: 650,
  quantity: 1,
})

describe("option trading decision dictionary", () => {
  it("provides an explicit broker translation for all four directions", () => {
    expect(OPTION_TRADE_DIRECTION_DICTIONARY).toEqual({
      BUY_CALL: {
        orderSide: "BUY",
        optionType: "CALL",
        symbolOptionType: "C",
      },
      BUY_PUT: {
        orderSide: "BUY",
        optionType: "PUT",
        symbolOptionType: "P",
      },
      SELL_CALL: {
        orderSide: "SELL",
        optionType: "CALL",
        symbolOptionType: "C",
      },
      SELL_PUT: {
        orderSide: "SELL",
        optionType: "PUT",
        symbolOptionType: "P",
      },
    })
  })

  it.each(directionCases)(
    "accepts %s with its matching single-leg strategy and symbol",
    (direction, strategy, contractSymbol) => {
      expect(
        optionTradingDecisionV1Schema.safeParse({
          contractVersion: "1.0.0",
          outcome: "PROPOSE_TRADE",
          decisionId: `decision-${direction.toLowerCase()}`,
          ticker: "SPY",
          strategy,
          thesis: "The evidence supports this candidate entry.",
          orders: [order(direction, contractSymbol)],
          invalidation: ["Reject if refreshed evidence changes the candidate."],
          evidence,
        }).success,
      ).toBe(true)
    },
  )

  it("accepts a bull call spread as ordered BUY_CALL and SELL_CALL legs", () => {
    expect(
      optionTradingDecisionV1Schema.safeParse({
        contractVersion: "1.0.0",
        outcome: "PROPOSE_TRADE",
        decisionId: "decision-bull-call-spread",
        ticker: "SPY",
        strategy: "BULL_CALL_SPREAD",
        thesis: "The evidence supports a defined-risk bullish entry.",
        orders: [
          order("BUY_CALL", "SPY260918C00650000"),
          {
            ...order("SELL_CALL", "SPY260918C00655000"),
            legId: "entry-2",
            strike: 655,
          },
        ],
        invalidation: ["Reject if refreshed evidence changes the candidate."],
        evidence,
      }).success,
    ).toBe(true)
  })

  it("rejects a direction whose option type disagrees with the symbol", () => {
    const result = optionTradingOrderLegV1Schema.safeParse(
      order("BUY_CALL", "SPY260918P00650000"),
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error("Expected validation to fail")
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({ path: ["contractSymbol"] }),
    )
  })

  it("rejects a leg whose ticker disagrees with its symbol", () => {
    const result = optionTradingOrderLegV1Schema.safeParse({
      ...order("BUY_CALL", "QQQ260918C00650000"),
      ticker: "SPY",
    })

    expect(result.success).toBe(false)
  })

  it("rejects a strategy with the wrong ordered directions", () => {
    const result = optionTradingDecisionV1Schema.safeParse({
      contractVersion: "1.0.0",
      outcome: "PROPOSE_TRADE",
      decisionId: "decision-invalid-spread",
      ticker: "SPY",
      strategy: "BULL_CALL_SPREAD",
      thesis: "The evidence supports a candidate.",
      orders: [
        order("SELL_CALL", "SPY260918C00650000"),
        {
          ...order("BUY_CALL", "SPY260918C00655000"),
          legId: "entry-2",
          strike: 655,
        },
      ],
      invalidation: ["Reject if the candidate changes."],
      evidence,
    })

    expect(result.success).toBe(false)
  })
})
