import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { runBacktestReplay } from "../src/backtest/replay.js"
import { canonicalJsonSha256 } from "../src/shared/canonical-json.js"
import {
  evaluateTradeIntentRiskV1,
  riskContractLegV1Schema,
  riskEvaluationInputV1Schema,
  riskEvaluationV1Schema,
  type RiskRejectionCode,
} from "../src/risk/risk-evaluation-v1.js"

const optionSymbol = (
  expiration: string,
  optionType: "C" | "P",
  strikeCents: number,
) =>
  `SPY${expiration.slice(2).replaceAll("-", "")}${optionType}${String(strikeCents * 10).padStart(8, "0")}`

const makeIntent = ({
  expiration = "2026-09-11",
  longStrikeCents = 60_000,
  shortStrikeCents = 60_500,
  longBidCents = 300,
  longAskCents = 310,
  shortBidCents = 100,
  shortAskCents = 110,
  evaluatedAt = "2026-08-27T14:30:00.000Z",
  providerTimestamp = "2026-08-27T14:29:30.000Z",
}: Readonly<{
  expiration?: string
  longStrikeCents?: number
  shortStrikeCents?: number
  longBidCents?: number
  longAskCents?: number
  shortBidCents?: number
  shortAskCents?: number
  evaluatedAt?: string
  providerTimestamp?: string
}> = {}) => {
  const longContractSymbol = optionSymbol(expiration, "C", longStrikeCents)
  const shortContractSymbol = optionSymbol(expiration, "C", shortStrikeCents)
  const entryLimitCentsPerShare = Math.ceil(
    (longBidCents + longAskCents - shortBidCents - shortAskCents) / 2,
  )
  const widthCentsPerShare = Math.abs(longStrikeCents - shortStrikeCents)
  return {
    contractVersion: "3.0.0",
    decisionContractVersion: "3.0.0",
    underlying: "SPY",
    direction: "BULLISH",
    structure: "BULL_CALL_SPREAD",
    expiration,
    longContractSymbol,
    shortContractSymbol,
    quoteSnapshotRef: "alpaca-proposal-quotes-v1",
    evaluatedAt,
    longQuote: {
      contractSymbol: longContractSymbol,
      feed: "INDICATIVE",
      bidCentsPerShare: longBidCents,
      askCentsPerShare: longAskCents,
      providerTimestamp,
    },
    shortQuote: {
      contractSymbol: shortContractSymbol,
      feed: "INDICATIVE",
      bidCentsPerShare: shortBidCents,
      askCentsPerShare: shortAskCents,
      providerTimestamp,
    },
    entryLimitCentsPerShare,
    widthCentsPerShare,
    maxLossCentsPerContract: entryLimitCentsPerShare * 100,
    maxProfitCentsPerContract:
      (widthCentsPerShare - entryLimitCentsPerShare) * 100,
    stopLossMarkHalfCentsPerShare: entryLimitCentsPerShare,
    profitTargetMarkHalfCentsPerShare:
      entryLimitCentsPerShare + widthCentsPerShare,
  } as const
}

const makeInput = (intent = makeIntent()) => ({
  intent,
  context: {
    provenance: "APPLICATION_VERIFIED",
    eligibility: {
      evaluatedAt: "2026-08-27T14:30:00.000Z",
      sessionDate: "2026-08-27",
      researchEligible: true,
      tradeIntentEligible: true,
      tradeIntentWindow: {
        slotStartedAt: "2026-08-27T14:30:00.000Z",
        deadline: "2026-08-27T14:35:00.000Z",
      },
      previousSessionDates: ["2026-08-26", "2026-08-25"],
    },
    account: {
      observedAt: "2026-08-27T14:29:00.000Z",
      status: "ACTIVE",
      tradingRestricted: false,
      multilegOptionsApproved: true,
      buyingPowerCents: 20_000_000,
      equityCents: 10_000_000,
      lastEquityCents: 10_050_000,
    },
    portfolio: {
      observedAt: "2026-08-27T14:29:00.000Z",
      consistent: true,
      openStrategyPositionCount: 0,
      pendingEntryCount: 0,
      entriesSubmittedToday: 0,
      dailyBreakerActive: false,
      competitionBreakerActive: false,
    },
    contracts: {
      slotStartedAt: "2026-08-27T14:30:00.000Z",
      observedAt: "2026-08-27T14:30:00.000Z",
      legs: [
        {
          role: "LONG",
          contractSymbol: intent.longContractSymbol,
          active: true,
          tradable: true,
          exerciseStyle: "AMERICAN",
          multiplier: 100,
          delta: 0.5,
          impliedVolatility: 0.2,
          gamma: 0.02,
          theta: -0.1,
          vega: 0.15,
          volume: 100,
          volumeDate: "2026-08-27",
          openInterest: 500,
          openInterestDate: "2026-08-25",
        },
        {
          role: "SHORT",
          contractSymbol: intent.shortContractSymbol,
          active: true,
          tradable: true,
          exerciseStyle: "AMERICAN",
          multiplier: 100,
          delta: 0.3,
          impliedVolatility: 0.2,
          gamma: 0.015,
          theta: -0.08,
          vega: 0.12,
          volume: 100,
          volumeDate: "2026-08-27",
          openInterest: 500,
          openInterestDate: "2026-08-25",
        },
      ],
    },
  },
})

type MutableInput = ReturnType<typeof makeInput>

const rejectionReasons = (input: unknown): readonly RiskRejectionCode[] => {
  const result = evaluateTradeIntentRiskV1(input)
  expect(riskEvaluationV1Schema.safeParse(result).success).toBe(true)
  expect(result.outcome).toBe("REJECTED")
  if (result.outcome !== "REJECTED") throw new Error("Expected rejection")
  return result.reasonCodes
}

const expectRejection = (
  mutate: (input: MutableInput) => void,
  reason: RiskRejectionCode,
) => {
  const input = makeInput()
  mutate(input)
  expect(rejectionReasons(input)).toContain(reason)
}

describe("evaluateTradeIntentRiskV1", () => {
  it("approves one eligible spread and reports exact buying power", () => {
    const input = makeInput()
    expect(riskEvaluationInputV1Schema.safeParse(input).success).toBe(true)

    const evaluation = evaluateTradeIntentRiskV1(input)
    expect(evaluation).toEqual({
      evaluationVersion: "1.0.0",
      ruleVersion: "1.2.0",
      outcome: "APPROVED",
      evaluatedAt: "2026-08-27T14:30:00.000Z",
      approvedQuantity: 1,
      maxLossCents: 20_000,
      projectedBuyingPowerCents: 19_980_000,
      spreadGreeks: {
        calculation: "LONG_MINUS_SHORT",
        netDelta: 0.2,
        netGamma: 0.005,
        netTheta: -0.02,
        netVega: 0.03,
      },
    })
    expect(canonicalJsonSha256(evaluation)).toBe("f7d8a919642fb9a389f631ba92d3a14599fcccf9959331d5cf9b92532c8ab386")

    expect(
      riskEvaluationV1Schema.safeParse({
        ...evaluation,
        ruleVersion: "1.0.0",
      }).success,
    ).toBe(true)
    expect(
      riskEvaluationV1Schema.safeParse({
        ...evaluation,
        ruleVersion: "1.1.0",
      }).success,
    ).toBe(true)
    expect(
      riskEvaluationV1Schema.safeParse({
        ...evaluation,
        ruleVersion: "1.3.0",
      }).success,
    ).toBe(false)
  })

  it("approves correctly signed bearish put-spread exposure", () => {
    const input = makeInput()
    const longContractSymbol = optionSymbol("2026-09-11", "P", 60_500)
    const shortContractSymbol = optionSymbol("2026-09-11", "P", 60_000)
    const bearish = {
      ...input,
      intent: {
        ...input.intent,
        direction: "BEARISH",
        structure: "BEAR_PUT_SPREAD",
        longContractSymbol,
        shortContractSymbol,
        longQuote: { ...input.intent.longQuote, contractSymbol: longContractSymbol },
        shortQuote: { ...input.intent.shortQuote, contractSymbol: shortContractSymbol },
      },
      context: {
        ...input.context,
        contracts: {
          ...input.context.contracts,
          legs: [
            {
              ...input.context.contracts.legs[0]!,
              contractSymbol: longContractSymbol,
              delta: -0.5,
            },
            {
              ...input.context.contracts.legs[1]!,
              contractSymbol: shortContractSymbol,
              delta: -0.3,
            },
          ],
        },
      },
    }

    expect(riskEvaluationInputV1Schema.safeParse(bearish).success).toBe(true)
    expect(evaluateTradeIntentRiskV1(bearish)).toMatchObject({
      outcome: "APPROVED",
      spreadGreeks: { netDelta: -0.2 },
    })
  })

  const untrustedInput = makeInput()
  untrustedInput.context.provenance =
    "AGENT_REPORTED" as "APPLICATION_VERIFIED"

  it.each([undefined, null, {}, { intent: {} }, untrustedInput])(
    "fails malformed or untrusted input closed",
    (input) => {
      expect(evaluateTradeIntentRiskV1(input)).toEqual({
        evaluationVersion: "1.0.0",
        ruleVersion: "1.2.0",
        outcome: "REJECTED",
        evaluatedAt: null,
        reasonCodes: ["RISK_INPUT_INVALID"],
      })
    },
  )

  it("checks market and trusted-state freshness", () => {
    expectRejection((input) => {
      input.context.eligibility.tradeIntentEligible = false
    }, "MARKET_WINDOW_INELIGIBLE")
    expectRejection((input) => {
      input.context.eligibility.evaluatedAt = "2026-08-27T14:35:00.000Z"
    }, "MARKET_WINDOW_INELIGIBLE")
    expectRejection((input) => {
      input.context.contracts.observedAt = "2026-08-27T14:28:59.999Z"
    }, "MARKET_DATA_STALE")
    expectRejection((input) => {
      input.context.contracts.slotStartedAt =
        "2026-08-27T14:15:00.000Z" as typeof input.context.contracts.slotStartedAt
    }, "SNAPSHOT_INTEGRITY_INVALID")
    expectRejection((input) => {
      input.context.contracts.observedAt = "2026-08-27T14:29:29.999Z"
    }, "SNAPSHOT_INTEGRITY_INVALID")
    expectRejection((input) => {
      input.context.account.observedAt = "2026-08-27T14:24:59.999Z"
    }, "ACCOUNT_STATE_STALE")
    expectRejection((input) => {
      input.context.portfolio.observedAt = "2026-08-27T14:30:00.001Z"
    }, "RECONCILIATION_STATE_STALE")

    const subMillisecondQuote = makeInput(
      makeIntent({
        evaluatedAt: "2026-08-27T14:30:00.001Z",
        providerTimestamp: "2026-08-27T14:29:00.001001Z",
      }),
    )
    subMillisecondQuote.context.eligibility.evaluatedAt =
      "2026-08-27T14:30:00.001Z"
    subMillisecondQuote.context.contracts.observedAt =
      "2026-08-27T14:30:00.001Z"
    expect(evaluateTradeIntentRiskV1(subMillisecondQuote).outcome).toBe(
      "APPROVED",
    )

    const priorSlotIntent = makeInput(
      makeIntent({
        evaluatedAt: "2026-08-27T14:29:59.999Z",
        providerTimestamp: "2026-08-27T14:29:30.000Z",
      }),
    )
    priorSlotIntent.context.contracts.observedAt =
      "2026-08-27T14:29:59.999Z"
    expect(rejectionReasons(priorSlotIntent)).toContain(
      "SNAPSHOT_INTEGRITY_INVALID",
    )
  })

  it("keeps pure risk contract syntax provider-neutral", () => {
    const leg = {
      ...makeInput().context.contracts.legs[0],
      contractSymbol: "QQQ260911C00610000",
    }

    expect(riskContractLegV1Schema.safeParse(leg).success).toBe(true)
    expectRejection((input) => {
      input.context.contracts.legs[0]!.contractSymbol = leg.contractSymbol
    }, "CONTRACT_IDENTITY_MISMATCH")

    const malformed = makeInput()
    malformed.context.contracts.legs[0]!.contractSymbol = "not-a-symbol"
    expect(evaluateTradeIntentRiskV1(malformed)).toEqual({
      evaluationVersion: "1.0.0",
      ruleVersion: "1.2.0",
      outcome: "REJECTED",
      evaluatedAt: null,
      reasonCodes: ["RISK_INPUT_INVALID"],
    })
  })

  it("checks contract identity and eligibility", () => {
    expectRejection((input) => {
      input.context.contracts.legs[0]!.contractSymbol =
        "SPY260911C00610000"
    }, "CONTRACT_IDENTITY_MISMATCH")
    expectRejection((input) => {
      input.context.contracts.legs[0]!.active = false
    }, "CONTRACT_INELIGIBLE")
    expectRejection((input) => {
      input.context.contracts.legs[1]!.exerciseStyle = "EUROPEAN"
    }, "CONTRACT_INELIGIBLE")
    expectRejection((input) => {
      input.context.contracts.legs[1]!.multiplier = 10
    }, "CONTRACT_INELIGIBLE")
  })

  it("checks expiration and spread-width boundaries", () => {
    expect(
      rejectionReasons(makeInput(makeIntent({ expiration: "2026-09-04" }))),
    ).toContain("EXPIRATION_INELIGIBLE")
    expect(
      rejectionReasons(
        makeInput(
          makeIntent({
            longStrikeCents: 60_000,
            shortStrikeCents: 60_050,
            longBidCents: 130,
            longAskCents: 140,
            shortBidCents: 100,
            shortAskCents: 110,
          }),
        ),
      ),
    ).toContain("SPREAD_WIDTH_INELIGIBLE")

    expect(
      evaluateTradeIntentRiskV1(
        makeInput(
          makeIntent({ longStrikeCents: 60_000, shortStrikeCents: 61_000 }),
        ),
      ).outcome,
    ).toBe("APPROVED")
  })

  it("checks Greeks, volume, open interest, and quote liquidity", () => {
    expectRejection((input) => {
      input.context.contracts.legs[0]!.delta = 0.449
    }, "CONTRACT_METRICS_INELIGIBLE")
    expectRejection((input) => {
      input.context.contracts.legs[1]!.impliedVolatility = 0
    }, "CONTRACT_METRICS_INELIGIBLE")
    expectRejection((input) => {
      input.context.contracts.legs[0]!.delta = -0.5
      input.context.contracts.legs[1]!.delta = -0.3
    }, "SPREAD_GREEKS_INELIGIBLE")
    expectRejection((input) => {
      input.context.contracts.legs[1]!.volume = 99
    }, "LIQUIDITY_INELIGIBLE")
    expectRejection((input) => {
      input.context.contracts.legs[0]!.openInterest = 499
    }, "LIQUIDITY_INELIGIBLE")
    expectRejection((input) => {
      input.context.contracts.legs[0]!.openInterestDate = "2026-08-24"
    }, "LIQUIDITY_INELIGIBLE")

    const oldestFirstLookback = makeInput()
    oldestFirstLookback.context.eligibility.previousSessionDates = [
      "2026-08-20",
      "2026-08-21",
      "2026-08-25",
      "2026-08-26",
    ]
    oldestFirstLookback.context.contracts.legs[0]!.openInterestDate =
      "2026-08-26"
    oldestFirstLookback.context.contracts.legs[1]!.openInterestDate =
      "2026-08-26"
    expect(evaluateTradeIntentRiskV1(oldestFirstLookback).outcome).toBe(
      "APPROVED",
    )

    oldestFirstLookback.context.contracts.legs[0]!.openInterestDate =
      "2026-08-20"
    expect(rejectionReasons(oldestFirstLookback)).toContain(
      "LIQUIDITY_INELIGIBLE",
    )

    expect(
      rejectionReasons(makeInput(makeIntent({ longAskCents: 321 }))),
    ).toContain("LIQUIDITY_INELIGIBLE")
  })

  it("checks combined-spread quote liquidity at the exact 20% boundary", () => {
    const exactBoundary = makeInput(
      makeIntent({
        longBidCents: 300,
        longAskCents: 310,
        shortBidCents: 200,
        shortAskCents: 210,
      }),
    )
    expect(evaluateTradeIntentRiskV1(exactBoundary).outcome).toBe("APPROVED")

    const aboveBoundary = makeInput(
      makeIntent({
        longBidCents: 300,
        longAskCents: 311,
        shortBidCents: 200,
        shortAskCents: 210,
      }),
    )
    expect(rejectionReasons(aboveBoundary)).toContain("LIQUIDITY_INELIGIBLE")
  })

  it("checks natural entry debit at the exact 60% width boundary", () => {
    const exactBoundary = makeInput(
      makeIntent({
        longBidCents: 500,
        longAskCents: 510,
        shortBidCents: 210,
        shortAskCents: 220,
      }),
    )
    expect(evaluateTradeIntentRiskV1(exactBoundary).outcome).toBe("APPROVED")

    const aboveBoundary = makeInput(
      makeIntent({
        longBidCents: 500,
        longAskCents: 510,
        shortBidCents: 209,
        shortAskCents: 219,
      }),
    )
    expect(rejectionReasons(aboveBoundary)).toContain("ENTRY_PRICE_INELIGIBLE")
  })

  it("checks exact price, loss, and buying-power thresholds", () => {
    expect(
      rejectionReasons(
        makeInput(
          makeIntent({
            longBidCents: 500,
            longAskCents: 510,
            shortBidCents: 100,
            shortAskCents: 110,
          }),
        ),
      ),
    ).toContain("ENTRY_PRICE_INELIGIBLE")

    expect(
      rejectionReasons(
        makeInput(
          makeIntent({
            shortStrikeCents: 61_000,
            longBidCents: 700,
            longAskCents: 710,
            shortBidCents: 100,
            shortAskCents: 110,
          }),
        ),
      ),
    ).toContain("MAX_LOSS_EXCEEDED")

    expectRejection((input) => {
      input.context.account.buyingPowerCents = 30_000
    }, "BUYING_POWER_RESERVE_INSUFFICIENT")
    expectRejection((input) => {
      input.context.account.buyingPowerCents = 39_999
    }, "BUYING_POWER_RESERVE_INSUFFICIENT")

    const equality = makeInput()
    equality.context.account.buyingPowerCents = 40_000
    expect(evaluateTradeIntentRiskV1(equality).outcome).toBe("APPROVED")

    const largeSafeInteger = makeInput()
    largeSafeInteger.context.account.buyingPowerCents = Number.MAX_SAFE_INTEGER
    expect(evaluateTradeIntentRiskV1(largeSafeInteger)).toMatchObject({
      outcome: "APPROVED",
      projectedBuyingPowerCents: Number.MAX_SAFE_INTEGER - 20_000,
    })
  })

  it("checks account, reconciliation, exposure, and entry limits", () => {
    expectRejection((input) => {
      input.context.account.status = "INACTIVE"
    }, "ACCOUNT_INELIGIBLE")
    expectRejection((input) => {
      input.context.account.tradingRestricted = true
    }, "ACCOUNT_INELIGIBLE")
    expectRejection((input) => {
      input.context.account.multilegOptionsApproved = false
    }, "ACCOUNT_INELIGIBLE")
    expectRejection((input) => {
      input.context.portfolio.consistent = false
    }, "RECONCILIATION_INCONSISTENT")
    expectRejection((input) => {
      input.context.portfolio.openStrategyPositionCount = 1
    }, "EXPOSURE_LIMIT_ACTIVE")
    expectRejection((input) => {
      input.context.portfolio.pendingEntryCount = 1
    }, "EXPOSURE_LIMIT_ACTIVE")
    expectRejection((input) => {
      input.context.portfolio.entriesSubmittedToday = 1
    }, "DAILY_ENTRY_LIMIT_ACTIVE")
  })

  it("checks latched and newly crossed circuit breakers inclusively", () => {
    expectRejection((input) => {
      input.context.portfolio.dailyBreakerActive = true
    }, "DAILY_BREAKER_ACTIVE")
    expectRejection((input) => {
      input.context.account.equityCents = 9_900_000
      input.context.account.lastEquityCents = 10_050_000
    }, "DAILY_BREAKER_ACTIVE")
    expectRejection((input) => {
      input.context.portfolio.competitionBreakerActive = true
    }, "COMPETITION_BREAKER_ACTIVE")
    expectRejection((input) => {
      input.context.account.equityCents = 9_250_000
      input.context.account.lastEquityCents = 9_250_000
    }, "COMPETITION_BREAKER_ACTIVE")
  })

  it("reserves full maximum loss against daily and competition budgets", () => {
    const dailyEquality = makeInput()
    dailyEquality.context.account.lastEquityCents = 10_130_000
    expect(rejectionReasons(dailyEquality)).toContain(
      "DAILY_LOSS_BUDGET_INSUFFICIENT",
    )

    const dailyBelow = makeInput()
    dailyBelow.context.account.lastEquityCents = 10_129_999
    expect(evaluateTradeIntentRiskV1(dailyBelow).outcome).toBe("APPROVED")

    const competitionEquality = makeInput()
    competitionEquality.context.account.equityCents = 9_270_000
    competitionEquality.context.account.lastEquityCents = 9_270_000
    expect(rejectionReasons(competitionEquality)).toContain(
      "COMPETITION_LOSS_BUDGET_INSUFFICIENT",
    )

    const competitionAbove = makeInput()
    competitionAbove.context.account.equityCents = 9_270_001
    competitionAbove.context.account.lastEquityCents = 9_270_001
    expect(evaluateTradeIntentRiskV1(competitionAbove).outcome).toBe("APPROVED")
  })

  it("reports active breakers without redundant projected-budget reasons", () => {
    const daily = makeInput()
    daily.context.portfolio.dailyBreakerActive = true
    daily.context.account.lastEquityCents = 10_130_000
    expect(rejectionReasons(daily)).toEqual(["DAILY_BREAKER_ACTIVE"])

    const competition = makeInput()
    competition.context.portfolio.competitionBreakerActive = true
    competition.context.account.equityCents = 9_270_000
    competition.context.account.lastEquityCents = 9_270_000
    expect(rejectionReasons(competition)).toEqual([
      "COMPETITION_BREAKER_ACTIVE",
    ])
  })

  it("returns multiple failures once in stable gate order", () => {
    const input = makeInput()
    input.context.eligibility.tradeIntentEligible = false
    input.context.account.status = "INACTIVE"
    input.context.portfolio.openStrategyPositionCount = 1
    input.context.portfolio.pendingEntryCount = 1

    expect(rejectionReasons(input)).toEqual([
      "MARKET_WINDOW_INELIGIBLE",
      "ACCOUNT_INELIGIBLE",
      "EXPOSURE_LIMIT_ACTIVE",
    ])
  })

  it("keeps symbol-specific policy out of the risk module", () => {
    const source = readFileSync(
      new URL("../src/risk/risk-evaluation-v1.ts", import.meta.url),
      "utf8",
    )
    expect(source).not.toContain("SPY")
  })
})

describe("backtest replay input validation", () => {
  const monitorCycle = {
    decidedAt: "2026-08-27T14:31:00.000Z",
    marketOpen: true,
    lateFill: false,
    dte: 15,
    minutesToClose: 329,
    staleMinutes: 0,
    markHalfCentsPerShare: 700,
    holdingSessionIndex: 1,
  } as const
  const scenario = {
    scenarioId: "scenario-1",
    riskInput: makeInput(),
    monitorCycles: [monitorCycle],
  }
  const replay = (scenarios: readonly unknown[]) => ({
    replayVersion: "7.0.0",
    initialEquityCents: 10_000_000,
    execution: {
      entrySlippageHalfCentsPerShare: 0,
      exitSlippageHalfCentsPerShare: 0,
      commissionCentsPerContract: 0,
    },
    sessions: [
      {
        date: "2026-08-27",
        open: "2026-08-27T13:30:00.000Z",
        close: "2026-08-27T20:00:00.000Z",
      },
      {
        date: "2026-08-28",
        open: "2026-08-28T13:30:00.000Z",
        close: "2026-08-28T20:00:00.000Z",
      },
    ],
    scenarios,
  })

  it("rejects pre-entry cycles, impossible marks, and duplicate scenario IDs", () => {
    expect(runBacktestReplay(replay([{ ...scenario, monitorCycles: [{
      ...monitorCycle,
      decidedAt: scenario.riskInput.intent.evaluatedAt,
      minutesToClose: 330,
      markHalfCentsPerShare:
        scenario.riskInput.intent.widthCentsPerShare * 2,
    }] }])).aggregate).toMatchObject({ status: "COMPLETE" })
    expect(() => runBacktestReplay(replay([{ ...scenario, monitorCycles: [{
      ...monitorCycle,
      decidedAt: "2026-08-27T14:29:59.999Z",
    }] }]))).toThrow(/cannot predate intent evaluation/u)
    expect(() => runBacktestReplay(replay([{ ...scenario, monitorCycles: [{
      ...monitorCycle,
      markHalfCentsPerShare:
        scenario.riskInput.intent.widthCentsPerShare * 2 + 1,
    }] }]))).toThrow(/cannot exceed the spread width/u)
    expect(() => runBacktestReplay(replay([scenario, scenario]))).toThrow(
      /scenario IDs must be unique/u,
    )
    expect(() => runBacktestReplay(replay([{ ...scenario, monitorCycles: [{
      ...monitorCycle,
      dte: monitorCycle.dte - 1,
    }] }]))).toThrow(/DTE must match/u)
    expect(runBacktestReplay(replay([{ ...scenario, monitorCycles: [{
      ...monitorCycle,
      markHalfCentsPerShare: undefined,
    }] }])).aggregate).toEqual({
      status: "INCOMPLETE",
      reason: "UNPRICED_EXIT",
    })
  })

  it("cross-checks holding-session indexes against the replay calendar", () => {
    expect(() => runBacktestReplay(replay([{ ...scenario, monitorCycles: [{
      ...monitorCycle,
      holdingSessionIndex: 5,
    }] }]))).toThrow(/holding-session index must match/u)
    expect(() => runBacktestReplay(replay([{ ...scenario, monitorCycles: [{
      ...monitorCycle,
      decidedAt: "2026-08-28T14:31:00.000Z",
      dte: 14,
      holdingSessionIndex: 1,
    }] }]))).toThrow(/holding-session index must match/u)
    expect(runBacktestReplay(replay([{ ...scenario, monitorCycles: [{
      ...monitorCycle,
      decidedAt: "2026-08-28T14:31:00.000Z",
      dte: 14,
      holdingSessionIndex: 2,
    }] }])).aggregate).toMatchObject({ status: "COMPLETE" })
  })

  it("cross-checks monitor timing against replay session hours", () => {
    expect(() => runBacktestReplay(replay([{ ...scenario, monitorCycles: [{
      ...monitorCycle,
      marketOpen: false,
    }] }]))).toThrow(/market state must match/u)
    expect(() => runBacktestReplay(replay([{ ...scenario, monitorCycles: [{
      ...monitorCycle,
      minutesToClose: 0,
    }] }]))).toThrow(/minutes to close must match/u)
  })

  it("requires intent evaluation during its retained entry session", () => {
    expect(() => runBacktestReplay(replay([{
      ...scenario,
      riskInput: {
        ...scenario.riskInput,
        intent: {
          ...scenario.riskInput.intent,
          evaluatedAt: "2026-08-27T12:30:00.000Z",
        },
      },
    }]))).toThrow(/evaluated during its entry session/u)
  })

  it("derives trend evidence from the prior 20 retained daily closes", () => {
    const dates = Array.from({ length: 21 }, (_, index) =>
      new Date(Date.UTC(2026, 7, 7 + index)).toISOString().slice(0, 10)
    )
    const sessions = dates.map((date) => ({
      date,
      open: `${date}T13:30:00.000Z`,
      close: `${date}T20:00:00.000Z`,
    }))
    const dailyCloses = dates.slice(0, -1).map((sessionDate) => ({
      sessionDate,
      closeMicros: 600_000_000,
    }))
    dailyCloses.at(-1)!.closeMicros = 600_000_011
    const replayWithTrend = (completedDailyCloseMicros: number) => ({
      ...replay([{
        ...scenario,
        dailyCloses,
        monitorCycles: [{
          ...monitorCycle,
          completedDailyCloseMicros,
          sma20Micros: 600_000_001,
        }],
      }]),
      sessions,
    })

    expect(runBacktestReplay(replayWithTrend(600_000_011)).aggregate)
      .toMatchObject({ status: "COMPLETE" })
    expect(() => runBacktestReplay(replayWithTrend(600_000_012)))
      .toThrow(/trend evidence must match/u)
  })
})
