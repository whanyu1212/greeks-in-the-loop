import { describe, expect, it } from "vitest"

import type { OptionUniverseSnapshotV2 } from "../src/contracts/option-universe-v2.js"
import {
  screenOptionUniverseV1,
  symbolScreenResultV1Schema,
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

describe("screenOptionUniverseV1", () => {
  it("maps qualified movers to supported directional debit spreads", () => {
    const screen = screenOptionUniverseV1(universe([
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
      screenVersion: "1.0.0",
      policyVersion: "1.0.0",
      mode: "SHADOW",
      evaluatedAt: "2026-08-26T14:30:00.000Z",
      results: [
        {
          underlying: "SPY",
          actionability: "ACTIONABLE",
          direction: "BULLISH",
          structure: "BULL_CALL_SPREAD",
          reasonCodes: [],
        },
        {
          underlying: "QQQ",
          actionability: "ACTIONABLE",
          direction: "BEARISH",
          structure: "BEAR_PUT_SPREAD",
          reasonCodes: [],
        },
      ],
    })
    expect(symbolScreenResultV1Schema.parse(screen)).toEqual(screen)
  })

  it("watches symbols without a sufficient directional move", () => {
    const screen = screenOptionUniverseV1(universe([
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

    expect(screen.results).toMatchObject([
      {
        actionability: "WATCH",
        direction: "NEUTRAL",
        reasonCodes: ["SESSION_MOVE_UNAVAILABLE"],
      },
      {
        actionability: "WATCH",
        direction: "NEUTRAL",
        reasonCodes: ["SESSION_MOVE_BELOW_THRESHOLD"],
      },
    ])
  })

  it("rejects symbols whose application-owned liquidity evidence is unsafe", () => {
    const screen = screenOptionUniverseV1(universe([
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

    expect(screen.results).toMatchObject([
      {
        actionability: "REJECTED",
        direction: "NEUTRAL",
        reasonCodes: ["OPTION_LIQUIDITY_UNAVAILABLE"],
      },
      {
        actionability: "REJECTED",
        direction: "NEUTRAL",
        reasonCodes: [
          "LIQUID_CONTRACT_COUNT_LOW",
          "OPEN_INTEREST_LOW",
          "OPEN_INTEREST_COVERAGE_LOW",
        ],
      },
    ])
    expect(screen.results.every(({ structure }) => structure === undefined)).toBe(
      true,
    )
  })
})
