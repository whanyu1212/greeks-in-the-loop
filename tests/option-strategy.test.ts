import { describe, expect, it } from "vitest"

import {
  ALPACA_OPTION_ORDER_CAPABILITY_VERSION,
  alpacaMinimumLevelFor,
  alpacaOptionEntryPlanV2Schema,
  evaluateAlpacaOpeningCoverageV1,
} from "../src/options/alpaca-capabilities.js"
import {
  OPTION_STRATEGIES,
  OPTION_STRATEGY_CATALOG,
} from "../src/options/strategy.js"

const call = (strike: number) =>
  `SPY261218C${String(strike * 1_000).padStart(8, "0")}`
const put = (strike: number) =>
  `SPY261218P${String(strike * 1_000).padStart(8, "0")}`

const plan = (
  strategy: keyof typeof OPTION_STRATEGY_CATALOG,
  legs: readonly Readonly<{
    contractSymbol: string
    ratioQuantity: number
    positionIntent: "BUY_TO_OPEN" | "SELL_TO_OPEN"
  }>[],
) => alpacaOptionEntryPlanV2Schema.parse({
  capabilityVersion: ALPACA_OPTION_ORDER_CAPABILITY_VERSION,
  strategy,
  underlying: "SPY",
  legs,
})

describe("option strategy catalog", () => {
  it("defines every strategy exactly once without naked short categories", () => {
    expect(Object.keys(OPTION_STRATEGY_CATALOG)).toEqual(OPTION_STRATEGIES)
    expect(OPTION_STRATEGIES).not.toContain("SHORT_CALL")
    expect(OPTION_STRATEGIES).not.toContain("SHORT_PUT")
  })

  it("maps Alpaca approval levels by strategy family", () => {
    expect(alpacaMinimumLevelFor("COVERED_CALL")).toBe(1)
    expect(alpacaMinimumLevelFor("LONG_CALL")).toBe(2)
    expect(alpacaMinimumLevelFor("IRON_CONDOR")).toBe(3)
  })
})

describe("Alpaca option order capabilities", () => {
  it("accepts simplified covered multi-leg ratios", () => {
    const butterfly = plan("CALL_BUTTERFLY", [
      { contractSymbol: call(500), ratioQuantity: 1, positionIntent: "BUY_TO_OPEN" },
      { contractSymbol: call(510), ratioQuantity: 2, positionIntent: "SELL_TO_OPEN" },
      { contractSymbol: call(520), ratioQuantity: 1, positionIntent: "BUY_TO_OPEN" },
    ])

    expect(evaluateAlpacaOpeningCoverageV1(butterfly)).toEqual({ covered: true })
  })

  it("accepts a later-expiring long option as calendar coverage", () => {
    const calendar = plan("CALENDAR_SPREAD", [
      {
        contractSymbol: "SPY261120C00500000",
        ratioQuantity: 1,
        positionIntent: "SELL_TO_OPEN",
      },
      {
        contractSymbol: call(500),
        ratioQuantity: 1,
        positionIntent: "BUY_TO_OPEN",
      },
    ])

    expect(evaluateAlpacaOpeningCoverageV1(calendar)).toEqual({ covered: true })
  })

  it("rejects ratios that are not in simplest form", () => {
    expect(alpacaOptionEntryPlanV2Schema.safeParse({
      capabilityVersion: ALPACA_OPTION_ORDER_CAPABILITY_VERSION,
      strategy: "BULL_CALL_SPREAD",
      underlying: "SPY",
      legs: [
        { contractSymbol: call(500), ratioQuantity: 2, positionIntent: "BUY_TO_OPEN" },
        { contractSymbol: call(510), ratioQuantity: 2, positionIntent: "SELL_TO_OPEN" },
      ],
    }).success).toBe(false)
  })

  it("rejects structurally uncovered short option exposure", () => {
    expect(alpacaOptionEntryPlanV2Schema.safeParse({
      capabilityVersion: ALPACA_OPTION_ORDER_CAPABILITY_VERSION,
      strategy: "DEFINED_RISK_MLEG",
      underlying: "SPY",
      legs: [
        { contractSymbol: call(500), ratioQuantity: 1, positionIntent: "BUY_TO_OPEN" },
        { contractSymbol: call(510), ratioQuantity: 2, positionIntent: "SELL_TO_OPEN" },
      ],
    }).success).toBe(false)
  })

  it("rejects legs that do not match the declared strategy", () => {
    expect(alpacaOptionEntryPlanV2Schema.safeParse({
      capabilityVersion: ALPACA_OPTION_ORDER_CAPABILITY_VERSION,
      strategy: "BULL_CALL_SPREAD",
      underlying: "SPY",
      legs: [
        { contractSymbol: call(500), ratioQuantity: 1, positionIntent: "SELL_TO_OPEN" },
        { contractSymbol: call(510), ratioQuantity: 1, positionIntent: "BUY_TO_OPEN" },
      ],
    }).success).toBe(false)
  })

  it("rejects closing intents from entry plans", () => {
    expect(alpacaOptionEntryPlanV2Schema.safeParse({
      capabilityVersion: ALPACA_OPTION_ORDER_CAPABILITY_VERSION,
      strategy: "LONG_CALL",
      underlying: "SPY",
      legs: [{
        contractSymbol: call(500),
        ratioQuantity: 1,
        positionIntent: "BUY_TO_CLOSE",
      }],
    }).success).toBe(false)
  })

  it("recognizes cash and share collateral as requiring later risk proof", () => {
    const coveredCall = plan("COVERED_CALL", [
      { contractSymbol: call(510), ratioQuantity: 1, positionIntent: "SELL_TO_OPEN" },
    ])
    const cashSecuredPut = plan("CASH_SECURED_PUT", [
      { contractSymbol: put(490), ratioQuantity: 1, positionIntent: "SELL_TO_OPEN" },
    ])

    expect(evaluateAlpacaOpeningCoverageV1(coveredCall)).toEqual({ covered: true })
    expect(evaluateAlpacaOpeningCoverageV1(cashSecuredPut)).toEqual({ covered: true })
  })
})
