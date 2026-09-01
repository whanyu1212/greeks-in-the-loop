import { describe, expect, it } from "vitest"

import type { OptionUniverseSnapshotV2 } from "../src/contracts/option-universe-v2.js"
import type { OptionStrategy } from "../src/options/strategy.js"
import {
  indexSymbolStrategyScreenV2,
  screenOptionUniverseV2,
  symbolScreenResultV1Schema,
  symbolScreenResultV2Schema,
  type SymbolScreenResultV2,
} from "../src/research/symbol-screen.js"

const liquidity = {
  expirationCount: 2,
  viableSeriesCount: 4,
  liquidSeriesCount: 3,
  contractCount: 40,
  liquidContractCount: 24,
  totalOpenInterest: 24_000,
  openInterestCoverage: 1,
} as const

const universe = (
  candidates: OptionUniverseSnapshotV2["candidates"],
): OptionUniverseSnapshotV2 => ({
  snapshotVersion: "2.0.0",
  policyVersion: "5.0.0",
  snapshotId: `option-universe-v2-${"a".repeat(64)}`,
  generatedAt: "2026-08-26T14:30:00.000Z",
  sessionDate: "2026-08-26",
  source: "ALPACA_OPTIONS_SCREENERS",
  candidates,
})

const assessment = (
  screen: SymbolScreenResultV2,
  underlying: string,
  strategy: OptionStrategy,
) => screen.symbols
  .find((symbol) => symbol.underlying === underlying)!
  .strategies.find((candidate) => candidate.strategy === strategy)!

describe("screenOptionUniverseV2", () => {
  it("maps qualified movers to supported directional debit spreads", () => {
    const screen = screenOptionUniverseV2(universe([
      {
        rank: 1,
        underlying: "SPY",
        activityRank: 1,
        sessionPercentChange: 1.25,
        optionLiquidity: liquidity,
      },
      {
        rank: 2,
        underlying: "QQQ",
        activityRank: 2,
        sessionPercentChange: -0.75,
        optionLiquidity: liquidity,
      },
    ]))

    expect(screen).toMatchObject({
      screenVersion: "2.0.0",
      policyVersion: "3.0.0",
      mode: "SHADOW",
      evaluatedAt: "2026-08-26T14:30:00.000Z",
      symbols: [{ underlying: "SPY" }, { underlying: "QQQ" }],
    })
    expect(assessment(screen, "SPY", "BULL_CALL_SPREAD")).toEqual({
      strategy: "BULL_CALL_SPREAD",
      actionability: "ACTIONABLE",
      reasonCodes: [],
    })
    expect(assessment(screen, "SPY", "BEAR_PUT_SPREAD")).toMatchObject({
      actionability: "REJECTED",
      reasonCodes: ["DIRECTION_MISMATCH"],
    })
    expect(assessment(screen, "QQQ", "BEAR_PUT_SPREAD")).toMatchObject({
      actionability: "ACTIONABLE",
      reasonCodes: [],
    })
    expect(assessment(screen, "QQQ", "LONG_PUT")).toMatchObject({
      actionability: "ACTIONABLE",
      reasonCodes: [],
    })
    expect(assessment(screen, "SPY", "IRON_CONDOR")).toMatchObject({
      actionability: "ACTIONABLE",
      reasonCodes: [],
    })
    expect(assessment(screen, "SPY", "DEFINED_RISK_MLEG")).toMatchObject({
      actionability: "UNAVAILABLE",
      reasonCodes: ["APPLICATION_SUPPORT_PENDING"],
    })
    expect(
      indexSymbolStrategyScreenV2(screen).get("SPY")?.get("BULL_CALL_SPREAD"),
    ).toEqual(assessment(screen, "SPY", "BULL_CALL_SPREAD"))
    expect(symbolScreenResultV2Schema.parse(screen)).toEqual(screen)
  })

  it("watches symbols without a sufficient directional move", () => {
    const screen = screenOptionUniverseV2(universe([
      {
        rank: 1,
        underlying: "SPY",
        optionLiquidity: liquidity,
      },
      {
        rank: 2,
        underlying: "QQQ",
        sessionPercentChange: 0.49,
        optionLiquidity: liquidity,
      },
    ]))

    expect(assessment(screen, "SPY", "BULL_CALL_SPREAD")).toMatchObject({
      actionability: "WATCH",
      reasonCodes: ["SESSION_MOVE_UNAVAILABLE"],
    })
    expect(assessment(screen, "QQQ", "BEAR_PUT_SPREAD")).toMatchObject({
      actionability: "WATCH",
      reasonCodes: ["SESSION_MOVE_BELOW_THRESHOLD"],
    })
  })

  it("rejects symbols whose application-owned liquidity evidence is unsafe", () => {
    const screen = screenOptionUniverseV2(universe([
      {
        rank: 1,
        underlying: "SPY",
        sessionPercentChange: 2,
      },
      {
        rank: 2,
        underlying: "QQQ",
        sessionPercentChange: -2,
        optionLiquidity: {
          ...liquidity,
          liquidContractCount: 2,
          totalOpenInterest: 500,
          openInterestCoverage: 0.5,
        },
      },
    ]))

    expect(assessment(screen, "SPY", "BULL_CALL_SPREAD")).toMatchObject({
      actionability: "REJECTED",
      reasonCodes: ["OPTION_LIQUIDITY_UNAVAILABLE"],
    })
    expect(assessment(screen, "QQQ", "BEAR_PUT_SPREAD")).toMatchObject({
      actionability: "REJECTED",
      reasonCodes: [
        "LIQUID_CONTRACT_COUNT_LOW",
        "OPEN_INTEREST_LOW",
        "OPEN_INTEREST_COVERAGE_LOW",
      ],
    })
  })

  it("retains V1 parsing only for persisted ledger screens", () => {
    expect(symbolScreenResultV1Schema.safeParse({
      screenVersion: "1.0.0",
      policyVersion: "1.0.0",
      mode: "SHADOW",
      evaluatedAt: "2026-08-26T14:30:00.000Z",
      universeSnapshotId: `option-universe-v2-${"a".repeat(64)}`,
      results: [],
    }).success).toBe(true)
  })
})
