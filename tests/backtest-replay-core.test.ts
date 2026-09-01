import { describe, expect, it } from "vitest"

import {
  aggregateReplayCents,
  simulateGenericReplayScenario,
  simulateReplayScenario,
} from "../src/backtest/replay-core.js"
import type { TradeIntentV3 } from "../src/contracts/trade-intent-v3.js"
import type { TradeIntentV4 } from "../src/contracts/trade-intent-v4.js"
import type { StrategyEconomicsV1 } from "../src/risk/strategy-economics-v1.js"

const intent = {
  direction: "BULLISH",
  entryLimitCentsPerShare: 100,
  stopLossMarkHalfCentsPerShare: 1,
  profitTargetMarkHalfCentsPerShare: 3,
} as TradeIntentV3

const cycle = {
  decidedAt: "2026-08-28T14:02:00.000Z",
  marketOpen: true,
  lateFill: false,
  dte: 21,
  minutesToClose: 358,
  staleMinutes: 0,
  markHalfCentsPerShare: 2,
  holdingSessionIndex: 1,
} as const

describe("backtest replay cents", () => {
  it("replays V4 debit premiums with explicit per-leg costs", () => {
    const genericIntent = {
      premiumEffect: "DEBIT",
      direction: "BULLISH",
      entryLimitCentsPerStrategyUnit: 210,
      legs: [{ ratioQuantity: 1 }, { ratioQuantity: 1 }],
    } as TradeIntentV4
    const economics = {
      entryPremiumCents: 21_000,
      maxLossCents: 21_000,
      maxProfitCents: 29_000,
    } as StrategyEconomicsV1
    const simulation = simulateGenericReplayScenario(
      genericIntent,
      economics,
      [{ ...cycle, closePremiumCentsPerStrategyUnit: 300 }],
      {
        entrySlippageCentsPerLeg: 1,
        exitSlippageCentsPerLeg: 2,
        commissionCentsPerContract: 50,
      },
      {
        stopLossBpsOfMaxLoss: 5_000,
        profitTargetBps: 3_000,
        minimumDte: 3,
        maxHoldingSessions: 5,
      },
    )

    expect(simulation).toEqual({
      outcome: "CLOSED",
      exitReason: "PROFIT_TARGET",
      exitDecidedAt: cycle.decidedAt,
      entryFillCentsPerStrategyUnit: 212,
      exitFillCentsPerStrategyUnit: 296,
      pnlCents: 8_200,
    })
  })

  it("rejects safe-integer execution costs whose P&L exceeds the safe range", () => {
    expect(() => simulateReplayScenario(intent, [cycle], {
      entrySlippageHalfCentsPerShare: 0,
      exitSlippageHalfCentsPerShare: 0,
      commissionCentsPerContract: Number.MAX_SAFE_INTEGER,
    })).toThrow("safe integer range")
  })

  it("rejects aggregate results that would otherwise round cents", () => {
    expect(() => aggregateReplayCents(1, [Number.MAX_SAFE_INTEGER, 1])).toThrow(
      "safe integer range",
    )
  })
})
