import { describe, expect, it } from "vitest"

import {
  tradeIntentV4Schema,
  type TradeIntentV4,
} from "../src/contracts/trade-intent-v4.js"
import { deriveStrategyEconomicsV1 } from "../src/risk/strategy-economics-v1.js"

const timestamp = "2026-08-27T14:30:00.000Z"

const leg = (
  contractSymbol: string,
  positionIntent: "BUY_TO_OPEN" | "SELL_TO_OPEN",
  bidCentsPerShare: number,
  askCentsPerShare: number,
  ratioQuantity = 1,
) => ({
  contractSymbol,
  positionIntent,
  ratioQuantity,
  quote: {
    contractSymbol,
    feed: "INDICATIVE" as const,
    bidCentsPerShare,
    askCentsPerShare,
    providerTimestamp: timestamp,
  },
})

const intent = (
  strategy: TradeIntentV4["strategy"],
  direction: TradeIntentV4["direction"],
  legs: TradeIntentV4["legs"],
  premiumEffect: TradeIntentV4["premiumEffect"],
  entryLimitCentsPerStrategyUnit: number,
) => tradeIntentV4Schema.parse({
  contractVersion: "4.0.0",
  decisionContractVersion: "4.0.0",
  underlying: "SPY",
  direction,
  strategy,
  quoteSnapshotRef: "quotes-SPY",
  evaluatedAt: timestamp,
  legs,
  premiumEffect,
  entryLimitCentsPerStrategyUnit,
})

describe("strategy economics v1", () => {
  it("derives debit and credit vertical payoff bounds", () => {
    const debit = deriveStrategyEconomicsV1(intent(
      "BULL_CALL_SPREAD",
      "BULLISH",
      [
        leg("SPY260918C00600000", "BUY_TO_OPEN", 300, 310),
        leg("SPY260918C00605000", "SELL_TO_OPEN", 100, 110),
      ],
      "DEBIT",
      210,
    ))
    expect(debit).toMatchObject({
      success: true,
      economics: { maxLossCents: 21_000, maxProfitCents: 29_000 },
    })

    const credit = deriveStrategyEconomicsV1(intent(
      "BEAR_CALL_SPREAD",
      "BEARISH",
      [
        leg("SPY260918C00600000", "SELL_TO_OPEN", 300, 310),
        leg("SPY260918C00605000", "BUY_TO_OPEN", 100, 110),
      ],
      "CREDIT",
      190,
    ))
    expect(credit).toMatchObject({
      success: true,
      economics: { maxLossCents: 31_000, maxProfitCents: 19_000 },
    })
  })

  it("derives long-option and butterfly bounds", () => {
    expect(deriveStrategyEconomicsV1(intent(
      "LONG_CALL",
      "BULLISH",
      [leg("SPY260918C00600000", "BUY_TO_OPEN", 300, 310)],
      "DEBIT",
      310,
    ))).toMatchObject({
      success: true,
      economics: { maxLossCents: 31_000, maxProfitCents: null },
    })

    expect(deriveStrategyEconomicsV1(intent(
      "CALL_BUTTERFLY",
      "NEUTRAL",
      [
        leg("SPY260918C00595000", "BUY_TO_OPEN", 100, 110),
        leg("SPY260918C00600000", "SELL_TO_OPEN", 100, 110, 2),
        leg("SPY260918C00605000", "BUY_TO_OPEN", 100, 110),
      ],
      "DEBIT",
      20,
    ))).toMatchObject({
      success: true,
      economics: { maxLossCents: 2_000, maxProfitCents: 48_000 },
    })
  })

  it("accounts for share, cash, and time-spread coverage", () => {
    expect(deriveStrategyEconomicsV1(intent(
      "COVERED_CALL",
      "NEUTRAL",
      [leg("SPY260918C00600000", "SELL_TO_OPEN", 300, 310)],
      "CREDIT",
      300,
    ))).toMatchObject({
      success: true,
      economics: { maxLossCents: 0, buyingPowerRequirementCents: 0 },
    })

    expect(deriveStrategyEconomicsV1(intent(
      "CASH_SECURED_PUT",
      "BULLISH",
      [leg("SPY260918P00600000", "SELL_TO_OPEN", 300, 310)],
      "CREDIT",
      300,
    ))).toMatchObject({
      success: true,
      economics: {
        maxLossCents: 5_970_000,
        buyingPowerRequirementCents: 6_000_000,
      },
    })

    expect(deriveStrategyEconomicsV1(intent(
      "CALENDAR_SPREAD",
      "NEUTRAL",
      [
        leg("SPY261016C00600000", "BUY_TO_OPEN", 140, 150),
        leg("SPY260918C00600000", "SELL_TO_OPEN", 100, 110),
      ],
      "DEBIT",
      50,
    ))).toMatchObject({
      success: true,
      economics: { maxLossCents: 5_000, maxProfitCents: null },
    })
  })
})
