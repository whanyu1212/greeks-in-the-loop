import { describe, expect, it } from "vitest"

import {
  aggregateReplayCents,
  simulateReplayScenario,
} from "../src/backtest/replay-core.js"
import type { TradeIntentV1 } from "../src/contracts/trade-intent-v1.js"

const intent = {
  direction: "BULLISH",
  entryLimitCentsPerShare: 100,
  stopLossMarkHalfCentsPerShare: 1,
  profitTargetMarkHalfCentsPerShare: 3,
} as TradeIntentV1

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
