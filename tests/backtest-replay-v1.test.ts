import { describe, expect, it } from "vitest"

import {
  deriveHistoricalBarProxyCyclesV1,
  evaluateBacktestSignalV1,
  runBacktestReplayV1,
} from "../src/backtest/replay-v1.js"
import { canonicalJsonSha256 } from "../src/shared/canonical-json.js"

const optionSymbol = (strikeCents: number) =>
  `SPY260911C${String(strikeCents * 10).padStart(8, "0")}`

const intent = (() => {
  const longContractSymbol = optionSymbol(60_000)
  const shortContractSymbol = optionSymbol(60_500)
  return {
    contractVersion: "1.0.0",
    decisionContractVersion: "1.0.0",
    strategyVersion: "1.0.0",
    direction: "BULLISH",
    structure: "BULL_CALL_SPREAD",
    expiration: "2026-09-11",
    longContractSymbol,
    shortContractSymbol,
    quoteSnapshotRef: "snapshot-1",
    evaluatedAt: "2026-08-27T14:30:00.000Z",
    longQuote: {
      contractSymbol: longContractSymbol,
      feed: "INDICATIVE",
      bidCentsPerShare: 300,
      askCentsPerShare: 310,
      providerTimestamp: "2026-08-27T14:29:30.000Z",
    },
    shortQuote: {
      contractSymbol: shortContractSymbol,
      feed: "INDICATIVE",
      bidCentsPerShare: 100,
      askCentsPerShare: 110,
      providerTimestamp: "2026-08-27T14:29:30.000Z",
    },
    entryLimitCentsPerShare: 200,
    widthCentsPerShare: 500,
    maxLossCentsPerContract: 20_000,
    maxProfitCentsPerContract: 30_000,
    stopLossMarkHalfCentsPerShare: 200,
    profitTargetMarkHalfCentsPerShare: 700,
  } as const
})()

const riskInput = {
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
          gamma: 0.01,
          theta: -0.02,
          vega: 0.05,
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
          gamma: 0.01,
          theta: -0.02,
          vega: 0.05,
          volume: 100,
          volumeDate: "2026-08-27",
          openInterest: 500,
          openInterestDate: "2026-08-25",
        },
      ],
    },
  },
} as const

const manifest = {
  definition: {
    datasetVersion: "1.0.0",
    normalizationVersion: "1.0.0",
    datasetId: "fixture",
    symbol: "SPY",
    fromDate: "2026-08-27",
    toDate: "2026-08-28",
    optionHistoricalFeed: "ALPACA_ACCOUNT_DEFAULT",
    optionSymbols: [],
    requestStartedAt: "2026-08-27T10:00:00.000Z",
  },
  partitions: [],
  complete: true,
  checksum: "a".repeat(64),
  limitations: [],
} as const

const monitorCycle = {
  decidedAt: "2026-08-28T15:00:00.000Z",
  marketOpen: true,
  lateFill: false,
  dte: 14,
  minutesToClose: 300,
  staleMinutes: 0,
  markHalfCentsPerShare: 700,
  completedDailyCloseMicros: 60_000_000,
  sma20Micros: 59_000_000,
  holdingSessionIndex: 2,
} as const

const execution = {
  modelVersion: "1.0.0",
  entrySlippageHalfCentsPerShare: 2,
  exitSlippageHalfCentsPerShare: 2,
  commissionCentsPerContract: 65,
} as const

describe("backtest replay v1", () => {
  it("uses strict SMA and VWAP inequalities", () => {
    const closes = Array.from({ length: 50 }, (_, index) => 50_000_000 + index * 100_000)
    const bullish = evaluateBacktestSignalV1({
      completedDailyClosesMicros: closes,
      completedMinuteBars: [{ vwapMicros: 54_000_000, volume: 10 }],
      underlyingBidMicros: 55_000_000,
      underlyingAskMicros: 55_000_000,
    })
    expect(bullish.direction).toBe("BULLISH")
    expect(
      evaluateBacktestSignalV1({
        completedDailyClosesMicros: closes,
        completedMinuteBars: [{ vwapMicros: 55_000_000, volume: 10 }],
        underlyingBidMicros: 55_000_000,
        underlyingAskMicros: 55_000_000,
      }).direction,
    ).toBe("NO_ACTION")
  })

  it("runs exact snapshots through production risk and a deterministic profit exit", () => {
    const report = runBacktestReplayV1(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [
        {
          scenarioId: "exact-1",
          fidelity: "EXACT_SNAPSHOT",
          signal: {
            completedDailyClosesMicros: Array.from(
              { length: 50 },
              (_, index) => 50_000_000 + index * 100_000,
            ),
            completedMinuteBars: [{ vwapMicros: 54_000_000, volume: 10 }],
            underlyingBidMicros: 55_000_000,
            underlyingAskMicros: 55_000_000,
          },
          candidates: [riskInput],
          monitorCycles: [monitorCycle],
        },
      ],
    })

    expect(report.results[0]).toMatchObject({
      fidelity: "EXACT_SNAPSHOT",
      signalDirection: "BULLISH",
      riskStatus: "APPROVED",
      outcome: "CLOSED",
      exitReason: "PROFIT_TARGET",
      pnlCents: 14_540,
    })
    const { checksum, ...reportWithoutChecksum } = report
    expect(checksum).toBe(canonicalJsonSha256(reportWithoutChecksum))
  })

  it("labels retained-intent runs as proxy and preserves exit priority", () => {
    const report = runBacktestReplayV1(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [
        {
          scenarioId: "proxy-1",
          fidelity: "HISTORICAL_BAR_PROXY",
          retainedIntent: intent,
          monitorCycles: [
            {
              ...monitorCycle,
              lateFill: true,
              dte: 1,
              staleMinutes: 10,
              markHalfCentsPerShare: 100,
            },
          ],
        },
      ],
    })

    expect(report.results[0]).toMatchObject({
      fidelity: "HISTORICAL_BAR_PROXY",
      signalDirection: "NOT_EVALUABLE",
      riskStatus: "NOT_EVALUABLE",
      exitReason: "LATE_FILL",
    })
  })

  it("derives proxy marks from synchronized bars in the selected dataset", () => {
    const bar = {
      timeframe: "1MINUTE",
      timestamp: "2026-08-27T15:00:00.000Z",
      openMicros: 5_000_000,
      highMicros: 5_100_000,
      lowMicros: 1_000_000,
      closeMicros: 5_050_000,
      volume: 10,
      vwapMicros: 5_025_000,
      tradeCount: 5,
    } as const
    const report = runBacktestReplayV1(
      manifest,
      {
        replayVersion: "1.0.0",
        execution,
        scenarios: [
          {
            scenarioId: "dataset-proxy",
            fidelity: "HISTORICAL_BAR_PROXY",
            retainedIntent: intent,
          },
        ],
      },
      [
        {
          recordType: "MARKET_SESSION",
          date: "2026-08-27",
          open: "2026-08-27T13:30:00.000Z",
          close: "2026-08-27T20:00:00.000Z",
        },
        {
          recordType: "OPTION_BAR",
          contractSymbol: intent.longContractSymbol,
          ...bar,
        },
        {
          recordType: "OPTION_BAR",
          contractSymbol: intent.shortContractSymbol,
          ...bar,
          openMicros: 1_400_000,
          highMicros: 1_500_000,
          lowMicros: 1_300_000,
          closeMicros: 1_400_000,
          vwapMicros: 1_400_000,
        },
      ],
    )

    expect(report.results[0]).toMatchObject({
      fidelity: "HISTORICAL_BAR_PROXY",
      riskStatus: "NOT_EVALUABLE",
      exitReason: "STOP_LOSS",
      exitFillHalfCentsPerShare: 0,
    })
  })

  it("uses only preceding-session daily bars for proxy trend snapshots", () => {
    const sessionDates = Array.from({ length: 21 }, (_, index) =>
      new Date(Date.parse("2026-08-07T00:00:00.000Z") + index * 86_400_000)
        .toISOString()
        .slice(0, 10),
    )
    const sessions = sessionDates.map((date) => ({
      recordType: "MARKET_SESSION" as const,
      date,
      open: `${date}T13:30:00.000Z`,
      close: `${date}T20:00:00.000Z`,
    }))
    const dailyBars = sessionDates.map((date, index) => ({
      recordType: "UNDERLYING_BAR" as const,
      symbol: "SPY" as const,
      timeframe: "1DAY" as const,
      timestamp: `${date}T04:00:00.000Z`,
      openMicros: 100_000_000,
      highMicros: 100_000_000,
      lowMicros: 100_000_000,
      closeMicros: index === 20 ? 1 : 100_000_000 + index,
      volume: 10,
      vwapMicros: 100_000_000,
    }))
    const timestamp = `${sessionDates[20]}T15:00:00.000Z`
    const cycles = deriveHistoricalBarProxyCyclesV1(
      [
        ...sessions,
        ...dailyBars,
        {
          recordType: "OPTION_BAR",
          contractSymbol: intent.longContractSymbol,
          timeframe: "1MINUTE",
          timestamp,
          openMicros: 5_000_000,
          highMicros: 5_000_000,
          lowMicros: 5_000_000,
          closeMicros: 5_000_000,
          volume: 10,
          vwapMicros: 5_000_000,
          tradeCount: 1,
        },
        {
          recordType: "OPTION_BAR",
          contractSymbol: intent.shortContractSymbol,
          timeframe: "1MINUTE",
          timestamp,
          openMicros: 1_000_000,
          highMicros: 1_000_000,
          lowMicros: 1_000_000,
          closeMicros: 1_000_000,
          volume: 10,
          vwapMicros: 1_000_000,
          tradeCount: 1,
        },
      ],
      { ...intent, evaluatedAt: `${sessionDates[20]}T14:30:00.000Z` },
    )

    expect(cycles).toHaveLength(1)
    expect(cycles[0]).toMatchObject({
      completedDailyCloseMicros: 100_000_019,
      sma20Micros: 100_000_009.5,
    })
  })

  it("reports mark-independent exits without a fabricated P&L", () => {
    const report = runBacktestReplayV1(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [
        {
          scenarioId: "unpriced-exit",
          fidelity: "HISTORICAL_BAR_PROXY",
          retainedIntent: intent,
          monitorCycles: [
            {
              decidedAt: "2026-08-28T15:00:00.000Z",
              marketOpen: true,
              lateFill: true,
              dte: 14,
              minutesToClose: 300,
              staleMinutes: 0,
              holdingSessionIndex: 2,
            },
          ],
        },
      ],
    })

    expect(report).toMatchObject({
      tradeCount: 1,
      pricedTradeCount: 0,
      unpricedExitCount: 1,
      totalPnlCents: 0,
      results: [
        {
          outcome: "EXIT_UNPRICED",
          exitReason: "LATE_FILL",
          pnlCents: null,
        },
      ],
    })
  })
})
