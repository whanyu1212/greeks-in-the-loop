import { describe, expect, it } from "vitest"

import {
  deriveHistoricalBarProxyCyclesV1,
  evaluateBacktestSignalV1,
  runBacktestReplayV1,
} from "../src/backtest/replay-v1.js"
import type { BacktestDatasetRecord } from "../src/backtest/dataset.js"
import { canonicalJsonSha256 } from "../src/shared/canonical-json.js"
import {
  computeBacktestDatasetIdV2,
} from "../src/backtest/dataset-v2.js"
import {
  createBacktestDatasetDefinitionV2Fixture,
  createReplayV1StrategyManifest,
  createSyntheticStrategyManifest,
} from "./fixtures/backtest-dataset-v2.js"

const optionSymbol = (strikeCents: number) =>
  `SPY260911C${String(strikeCents * 10).padStart(8, "0")}`

const intent = (() => {
  const longContractSymbol = optionSymbol(60_000)
  const shortContractSymbol = optionSymbol(60_500)
  return {
    contractVersion: "1.0.0",
    decisionContractVersion: "1.0.0",
    strategyVersion: "1.1.0",
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
      previousSessionDates: ["2026-08-25", "2026-08-26"],
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

const proxyManifest = {
  ...manifest,
  definition: {
    ...manifest.definition,
    optionSymbols: [intent.longContractSymbol, intent.shortContractSymbol],
  },
} as const

const precedingSessionDates = (() => {
  const dates: string[] = []
  let timestamp = Date.parse("2026-08-27T00:00:00.000Z")
  while (dates.length < 50) {
    timestamp -= 86_400_000
    const day = new Date(timestamp).getUTCDay()
    if (day !== 0 && day !== 6) dates.push(new Date(timestamp).toISOString().slice(0, 10))
  }
  return dates.reverse()
})()

const replaySessionDates = [...precedingSessionDates, "2026-08-27", "2026-08-28"]
const replayCalendar: readonly BacktestDatasetRecord[] = [
  ...replaySessionDates.map((date) => ({
    recordType: "MARKET_SESSION" as const,
    date,
    open: `${date}T13:30:00.000Z`,
    close: `${date}T20:00:00.000Z`,
  })),
  ...replaySessionDates.slice(0, -1).map((date) => ({
    recordType: "UNDERLYING_BAR" as const,
    symbol: "SPY" as const,
    timeframe: "1DAY" as const,
    timestamp: `${date}T04:00:00.000Z`,
    openMicros: date === "2026-08-27" ? 60_000_000 : date === "2026-08-26" ? 59_000_000 : 58_000_000,
    highMicros: date === "2026-08-27" ? 60_000_000 : date === "2026-08-26" ? 59_000_000 : 58_000_000,
    lowMicros: date === "2026-08-27" ? 60_000_000 : date === "2026-08-26" ? 59_000_000 : 58_000_000,
    closeMicros: date === "2026-08-27" ? 60_000_000 : date === "2026-08-26" ? 59_000_000 : 58_000_000,
    volume: 10,
    vwapMicros: date === "2026-08-27" ? 60_000_000 : date === "2026-08-26" ? 59_000_000 : 58_000_000,
  })),
]

const runReplay = (
  manifestInput: unknown,
  replayInput: unknown,
  records: readonly BacktestDatasetRecord[] = replayCalendar,
) => runBacktestReplayV1(manifestInput, replayInput, records)

const monitorCycle = {
  decidedAt: "2026-08-28T15:00:00.000Z",
  marketOpen: true,
  lateFill: false,
  dte: 14,
  minutesToClose: 300,
  staleMinutes: 0,
  markHalfCentsPerShare: 700,
  completedDailyCloseMicros: 60_000_000,
  sma20Micros: 58_150_000,
  holdingSessionIndex: 2,
} as const

const execution = {
  modelVersion: "1.0.0",
  entrySlippageHalfCentsPerShare: 2,
  exitSlippageHalfCentsPerShare: 2,
  commissionCentsPerContract: 65,
} as const

const signalSnapshot = (
  closes: readonly number[] = Array.from(
    { length: 50 },
    (_, index) => 50_000_000 + index * 100_000,
  ),
  minuteVwapMicros = 54_000_000,
) => ({
  sessionDate: "2026-08-27",
  observedAt: intent.evaluatedAt,
  precedingSessionDates,
  completedDailyBars: closes.map((closeMicros, index) => ({
    feed: "IEX" as const,
    adjustment: "all" as const,
    sessionDate: precedingSessionDates[index]!,
    closeMicros,
  })),
  completedMinuteBars: Array.from({ length: 60 }, (_, index) => ({
    feed: "IEX" as const,
    startedAt: new Date(Date.parse("2026-08-27T13:30:00.000Z") + index * 60_000)
      .toISOString(),
    vwapMicros: minuteVwapMicros,
    volume: 10,
  })),
  underlyingQuote: {
    feed: "IEX" as const,
    providerTimestamp: "2026-08-27T14:29:30.000Z",
    bidMicros: 55_000_000,
    askMicros: 55_000_000,
  },
})

describe("backtest replay v1", () => {
  it("admits a compatible V2 dataset and rejects embedded replay identity drift", () => {
    const definition = createBacktestDatasetDefinitionV2Fixture({
      strategyManifest: createReplayV1StrategyManifest(),
      optionSymbols: [],
    })
    const compatible = {
      ...manifest,
      definition,
      checksum: "b".repeat(64),
    }
    expect(
      runReplay(compatible, {
        replayVersion: "1.0.0",
        execution,
        scenarios: [{
          scenarioId: "v2-proxy",
          fidelity: "HISTORICAL_BAR_PROXY",
          retainedIntent: intent,
          monitorCycles: [monitorCycle],
        }],
      }, replayCalendar),
    ).toMatchObject({
      datasetId: definition.datasetId,
      datasetChecksum: "b".repeat(64),
      scenarioCount: 1,
    })

    const driftedManifest = {
      ...createSyntheticStrategyManifest("QQQ"),
      replayCompatibility: {
        ...createSyntheticStrategyManifest("QQQ").replayCompatibility,
        replayVersion: "9.9.9",
      },
    }
    const driftedDefinition = createBacktestDatasetDefinitionV2Fixture({
      strategyManifest: driftedManifest,
      optionSymbols: [],
    })
    expect(() =>
      runReplay({
        ...compatible,
        definition: driftedDefinition,
      }, {
        replayVersion: "1.0.0",
        execution,
        scenarios: [{
          scenarioId: "drifted-v2-proxy",
          fidelity: "HISTORICAL_BAR_PROXY",
          retainedIntent: intent,
          monitorCycles: [monitorCycle],
        }],
      }, [])
    ).toThrow("replay identity is incompatible")
  })

  it("rejects reidentified V2 datasets with retained manifest prompt drift", () => {
    const original = createBacktestDatasetDefinitionV2Fixture({
      strategyManifest: createReplayV1StrategyManifest(),
      optionSymbols: [],
    })
    const { datasetId: _datasetId, ...content } = original
    const driftedContent = {
      ...content,
      strategyManifest: {
        ...content.strategyManifest,
        researchPlanCompatibility: {
          ...content.strategyManifest.researchPlanCompatibility,
          promptVersion: "9.9.9",
        },
      },
    }
    const definition = {
      ...driftedContent,
      datasetId: computeBacktestDatasetIdV2(driftedContent),
    }

    expect(() => runReplay({
      ...manifest,
      definition,
      checksum: "b".repeat(64),
    }, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [{
        scenarioId: "prompt-drift-v2-proxy",
        fidelity: "HISTORICAL_BAR_PROXY",
        retainedIntent: intent,
        monitorCycles: [monitorCycle],
      }],
    }, replayCalendar)).toThrow("replay identity is incompatible")
  })

  it("rejects unsupported embedded V2 executable component identity", () => {
    const original = createBacktestDatasetDefinitionV2Fixture({
      optionSymbols: [],
    })
    const { datasetId: _datasetId, ...content } = original
    const driftedContent = {
      ...content,
      replayComponents: {
        ...content.replayComponents,
        riskRule: {
          ...content.replayComponents.riskRule,
          componentVersion: "9.9.9",
        },
      },
    }
    const driftedDefinition = {
      ...driftedContent,
      datasetId: computeBacktestDatasetIdV2(driftedContent),
    }

    expect(() =>
      runReplay({
        ...manifest,
        definition: driftedDefinition,
        checksum: "b".repeat(64),
      }, {
        replayVersion: "1.0.0",
        execution,
        scenarios: [{
          scenarioId: "unsupported-component-proxy",
          fidelity: "HISTORICAL_BAR_PROXY",
          retainedIntent: intent,
          monitorCycles: [monitorCycle],
        }],
      }, replayCalendar)
    ).toThrow("replay identity is incompatible")
  })

  it("rejects internally consistent but unsupported V2 data versions", () => {
    const strategyManifest = {
      ...createSyntheticStrategyManifest("SPY"),
      replayCompatibility: {
        ...createSyntheticStrategyManifest("SPY").replayCompatibility,
        datasetVersion: "9.9.9",
        normalizationVersion: "9.9.9",
      },
    }
    const definition = createBacktestDatasetDefinitionV2Fixture({
      strategyManifest,
      optionSymbols: [],
    })

    expect(() =>
      runReplay({
        ...manifest,
        definition,
        checksum: "b".repeat(64),
      }, {
        replayVersion: "1.0.0",
        execution,
        scenarios: [{
          scenarioId: "unsupported-data-proxy",
          fidelity: "HISTORICAL_BAR_PROXY",
          retainedIntent: intent,
          monitorCycles: [monitorCycle],
        }],
      }, replayCalendar)
    ).toThrow("replay identity is incompatible")
  })

  it("rejects a V2 dataset outside the retained V1 manifest allowlist", () => {
    const definition = createBacktestDatasetDefinitionV2Fixture({
      strategyManifest: createReplayV1StrategyManifest("QQQ"),
      optionSymbols: [],
    })
    expect(() =>
      runReplay({
        ...manifest,
        definition,
        checksum: "b".repeat(64),
      }, {
        replayVersion: "1.0.0",
        execution,
        scenarios: [{
          scenarioId: "cross-symbol-proxy",
          fidelity: "HISTORICAL_BAR_PROXY",
          retainedIntent: intent,
          monitorCycles: [monitorCycle],
        }],
      }, [])
    ).toThrow("replay identity is incompatible")
  })

  it("context-validates V2 records for direct replay callers", () => {
    const definition = createBacktestDatasetDefinitionV2Fixture({
      optionSymbols: [],
    })
    expect(() =>
      runReplay({
        ...manifest,
        definition,
        checksum: "b".repeat(64),
      }, {
        replayVersion: "1.0.0",
        execution,
        scenarios: [],
      }, [{
        recordType: "UNDERLYING_BAR",
        symbol: "QQQ",
        timeframe: "1DAY",
        timestamp: "2024-06-03T13:30:00.000Z",
        openMicros: 1,
        highMicros: 1,
        lowMicros: 1,
        closeMicros: 1,
        volume: 1,
        vwapMicros: 1,
      }])
    ).toThrow("does not match")
  })
  it("uses strict SMA and VWAP inequalities", () => {
    const closes = Array.from({ length: 50 }, (_, index) => 50_000_000 + index * 100_000)
    const bullish = evaluateBacktestSignalV1(signalSnapshot(closes))
    expect(bullish.direction).toBe("BULLISH")
    expect(evaluateBacktestSignalV1(signalSnapshot(closes, 55_000_000)).direction)
      .toBe("NO_ACTION")
  })

  it("rejects incomplete or duplicate exact signal intervals", () => {
    const signal = signalSnapshot()
    expect(() => evaluateBacktestSignalV1({
      ...signal,
      completedMinuteBars: signal.completedMinuteBars.slice(1),
    })).toThrow(/every completed regular-session minute/u)
    expect(() => evaluateBacktestSignalV1({
      ...signal,
      completedMinuteBars: [
        ...signal.completedMinuteBars.slice(0, -1),
        signal.completedMinuteBars.at(-2)!,
      ],
    })).toThrow(/unique, complete, and chronological/u)
    expect(() => evaluateBacktestSignalV1({
      ...signal,
      completedDailyBars: [
        ...signal.completedDailyBars.slice(0, -1),
        signal.completedDailyBars.at(-2)!,
      ],
    })).toThrow(/one-to-one to 50 unique preceding sessions/u)
  })

  it("requires IEX provenance for exact signal minute bars", () => {
    const signal = signalSnapshot()
    expect(() => evaluateBacktestSignalV1({
      ...signal,
      completedMinuteBars: [
        { ...signal.completedMinuteBars[0]!, feed: "SIP" },
        ...signal.completedMinuteBars.slice(1),
      ],
    } as never)).toThrow(/Invalid input/u)
  })

  it("requires IEX adjusted provenance for exact signal daily bars", () => {
    const signal = signalSnapshot()
    expect(() => evaluateBacktestSignalV1({
      ...signal,
      completedDailyBars: [
        ...signal.completedDailyBars.slice(0, -1),
        { ...signal.completedDailyBars.at(-1)!, adjustment: "raw" },
      ],
    } as never)).toThrow(/Invalid input/u)
  })

  it("matches all exact daily dates to the retained market calendar", () => {
    const signal = signalSnapshot()
    expect(() => runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [{
        scenarioId: "invalid-exact-calendar",
        fidelity: "EXACT_SNAPSHOT",
        signal: {
          ...signal,
          precedingSessionDates: ["2026-01-01", ...signal.precedingSessionDates.slice(1)],
          completedDailyBars: [
            { ...signal.completedDailyBars[0]!, sessionDate: "2026-01-01" },
            ...signal.completedDailyBars.slice(1),
          ],
        },
        candidates: [riskInput],
        monitorCycles: [monitorCycle],
      }],
    })).toThrow(/exact daily bars do not match the replay calendar/u)
  })

  it("rejects stale or future exact underlying quotes", () => {
    const signal = signalSnapshot()
    expect(() => evaluateBacktestSignalV1({
      ...signal,
      underlyingQuote: {
        ...signal.underlyingQuote,
        providerTimestamp: "2026-08-27T14:28:59.999Z",
      },
    })).toThrow(/current-session and fresh/u)
    expect(() => evaluateBacktestSignalV1({
      ...signal,
      underlyingQuote: {
        ...signal.underlyingQuote,
        providerTimestamp: "2026-08-27T14:30:00.001Z",
      },
    })).toThrow(/current-session and fresh/u)
  })

  it("rechecks exact underlying quote freshness at candidate approval", () => {
    expect(() => runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [
        {
          scenarioId: "stale-at-approval",
          fidelity: "EXACT_SNAPSHOT",
          signal: signalSnapshot(),
          candidates: [{
            ...riskInput,
            context: {
              ...riskInput.context,
              eligibility: {
                ...riskInput.context.eligibility,
                evaluatedAt: "2026-08-27T14:30:31.000Z",
              },
            },
          }],
          monitorCycles: [monitorCycle],
        },
      ],
    })).toThrow(/remain fresh at candidate approval/u)
  })

  it("requires exact candidates to share one application approval context", () => {
    expect(() => runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [{
        scenarioId: "split-approval-context",
        fidelity: "EXACT_SNAPSHOT",
        signal: signalSnapshot(),
        candidates: [
          riskInput,
          {
            ...riskInput,
            context: {
              ...riskInput.context,
              account: {
                ...riskInput.context.account,
                buyingPowerCents: riskInput.context.account.buyingPowerCents - 1,
              },
            },
          },
        ],
        monitorCycles: [monitorCycle],
      }],
    })).toThrow(/share one application approval context/u)
  })

  it("rejects exact candidate deltas beyond snapshot normalization precision", () => {
    const long = riskInput.context.contracts.legs[0]
    expect(() => runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [{
        scenarioId: "fractional-millionth-delta",
        fidelity: "EXACT_SNAPSHOT",
        signal: signalSnapshot(),
        candidates: [{
          ...riskInput,
          context: {
            ...riskInput.context,
            contracts: {
              ...riskInput.context.contracts,
              legs: [
                { ...long, delta: 0.5000001 },
                riskInput.context.contracts.legs[1],
              ],
            },
          },
        }],
        monitorCycles: [monitorCycle],
      }],
    })).toThrow(/six-decimal precision/u)
  })

  it("runs exact snapshots through production risk and a deterministic profit exit", () => {
    const report = runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [
        {
          scenarioId: "exact-1",
          fidelity: "EXACT_SNAPSHOT",
          signal: signalSnapshot(),
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
    expect(checksum).toBe("37249c41f99be7be5fa8823f9519be3468909c86fd26f6cc439546ce47f07bc4")
  })

  it("labels retained-intent runs as proxy and preserves exit priority", () => {
    const report = runReplay(manifest, {
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

  it("decodes a retained legacy V1 intent without current manifest fields", () => {
    const report = runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [
        {
          scenarioId: "legacy-proxy",
          fidelity: "HISTORICAL_BAR_PROXY",
          retainedIntent: { ...intent, strategyVersion: "1.0.0" },
          monitorCycles: [monitorCycle],
        },
      ],
    })

    expect(report.results[0]).toMatchObject({
      outcome: "CLOSED",
      intent: { strategyVersion: "1.0.0" },
    })
  })

  it("does not latch exits from closed-market cycles", () => {
    const report = runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [
        {
          scenarioId: "closed-market",
          fidelity: "HISTORICAL_BAR_PROXY",
          retainedIntent: intent,
          monitorCycles: [
            {
              ...monitorCycle,
              decidedAt: "2026-08-28T12:00:00.000Z",
              marketOpen: false,
              minutesToClose: 480,
              markHalfCentsPerShare: 0,
            },
            monitorCycle,
          ],
        },
      ],
    })

    expect(report.results[0]).toMatchObject({
      exitReason: "PROFIT_TARGET",
      exitDecidedAt: monitorCycle.decidedAt,
    })
  })

  it("rejects a closed-market end cycle during session hours", () => {
    expect(() => runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [{
        scenarioId: "closed-market-end",
        fidelity: "HISTORICAL_BAR_PROXY",
        retainedIntent: intent,
        monitorCycles: [{
          ...monitorCycle,
          marketOpen: false,
          markHalfCentsPerShare: 500,
        }],
      }],
    })).toThrow(/incorrect market-open state/u)
  })

  it("rejects monitor cycles that are not strictly chronological", () => {
    expect(() => runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [
        {
          scenarioId: "unordered-cycles",
          fidelity: "HISTORICAL_BAR_PROXY",
          retainedIntent: intent,
          monitorCycles: [
            monitorCycle,
            { ...monitorCycle, decidedAt: "2026-08-28T14:59:00.000Z" },
          ],
        },
      ],
    })).toThrow(/Monitor cycle timestamps must be strictly increasing/u)
  })

  it("keeps late-fill protection latched across monitor cycles", () => {
    expect(() => runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [{
        scenarioId: "unlatched-late-fill",
        fidelity: "HISTORICAL_BAR_PROXY",
        retainedIntent: intent,
        monitorCycles: [
          {
            ...monitorCycle,
            decidedAt: "2026-08-28T12:00:00.000Z",
            marketOpen: false,
            lateFill: true,
            minutesToClose: 480,
          },
          monitorCycle,
        ],
      }],
    })).toThrow(/Late-fill protection must remain latched/u)
  })

  it("rejects monitor cycles that predate intent evaluation", () => {
    expect(() => runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [
        {
          scenarioId: "pre-entry-cycle",
          fidelity: "HISTORICAL_BAR_PROXY",
          retainedIntent: intent,
          monitorCycles: [{
            ...monitorCycle,
            decidedAt: "2026-08-27T14:29:59.999Z",
          }],
        },
      ],
    })).toThrow(/monitor cycle before intent evaluation/u)
  })

  it("rejects explicit monitor DTE that disagrees with the contract expiration", () => {
    expect(() => runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [{
        scenarioId: "incorrect-dte",
        fidelity: "HISTORICAL_BAR_PROXY",
        retainedIntent: intent,
        monitorCycles: [{ ...monitorCycle, dte: 2 }],
      }],
    })).toThrow(/monitor cycle with incorrect DTE/u)
  })

  it("rejects explicit holding age that disagrees with the replay calendar", () => {
    expect(() => runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [{
        scenarioId: "incorrect-holding-age",
        fidelity: "HISTORICAL_BAR_PROXY",
        retainedIntent: intent,
        monitorCycles: [{ ...monitorCycle, holdingSessionIndex: 1 }],
      }],
    })).toThrow(/incorrect holding session index/u)
  })

  it("rejects explicit minutes to close that disagree with the replay calendar", () => {
    expect(() => runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [{
        scenarioId: "incorrect-minutes-to-close",
        fidelity: "HISTORICAL_BAR_PROXY",
        retainedIntent: intent,
        monitorCycles: [{ ...monitorCycle, minutesToClose: 299 }],
      }],
    })).toThrow(/incorrect minutes to session close/u)
  })

  it("rejects cycles claiming open market outside retained session hours", () => {
    expect(() => runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [{
        scenarioId: "after-hours-open",
        fidelity: "HISTORICAL_BAR_PROXY",
        retainedIntent: intent,
        monitorCycles: [{
          ...monitorCycle,
          decidedAt: "2026-08-28T21:00:00.000Z",
          minutesToClose: 0,
        }],
      }],
    })).toThrow(/incorrect market-open state/u)
  })

  it("validates explicit trend evidence against retained daily bars", () => {
    expect(() => runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [{
        scenarioId: "invalid-trend-evidence",
        fidelity: "HISTORICAL_BAR_PROXY",
        retainedIntent: intent,
        monitorCycles: [{
          ...monitorCycle,
          sma20Micros: monitorCycle.sma20Micros + 1,
        }],
      }],
    })).toThrow(/invalid trend evidence/u)
  })

  it("rejects explicit marks above the spread width", () => {
    expect(() => runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [
        {
          scenarioId: "impossible-mark",
          fidelity: "HISTORICAL_BAR_PROXY",
          retainedIntent: intent,
          monitorCycles: [{
            ...monitorCycle,
            markHalfCentsPerShare: intent.widthCentsPerShare * 2 + 1,
          }],
        },
      ],
    })).toThrow(/mark above the spread width/u)
  })

  it("compares offset timestamps by instant", () => {
    const report = runReplay(manifest, {
      replayVersion: "1.0.0",
      execution,
      scenarios: [
        {
          scenarioId: "offset-instants",
          fidelity: "HISTORICAL_BAR_PROXY",
          retainedIntent: intent,
          monitorCycles: [
            {
              ...monitorCycle,
              decidedAt: "2026-08-27T14:31:00.000Z",
              dte: 15,
              minutesToClose: 329,
              markHalfCentsPerShare: 400,
              holdingSessionIndex: 1,
              completedDailyCloseMicros: 59_000_000,
              sma20Micros: 58_050_000,
            },
            {
              ...monitorCycle,
              decidedAt: "2026-08-27T10:32:00.000-04:00",
              dte: 15,
              minutesToClose: 328,
              holdingSessionIndex: 1,
              completedDailyCloseMicros: 59_000_000,
              sma20Micros: 58_050_000,
            },
          ],
        },
      ],
    })

    expect(report.results[0]).toMatchObject({
      exitReason: "PROFIT_TARGET",
      exitDecidedAt: "2026-08-27T10:32:00.000-04:00",
    })
  })

  it("derives proxy marks from synchronized bars in the selected dataset", () => {
    const offsetIntent = { ...intent, evaluatedAt: "2026-08-27T10:30:30.000-04:00" }
    const bar = {
      timeframe: "1MINUTE",
      timestamp: intent.evaluatedAt,
      openMicros: 5_000_000,
      highMicros: 5_100_000,
      lowMicros: 1_000_000,
      closeMicros: 5_050_000,
      volume: 10,
      vwapMicros: 5_025_000,
      tradeCount: 5,
    } as const
    const report = runReplay(
      proxyManifest,
      {
        replayVersion: "1.0.0",
        execution,
        scenarios: [
          {
            scenarioId: "dataset-proxy",
            fidelity: "HISTORICAL_BAR_PROXY",
            retainedIntent: offsetIntent,
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
      exitDecidedAt: "2026-08-27T14:31:00.000Z",
      exitFillHalfCentsPerShare: 0,
    })
  })

  it("requires both retained proxy legs in the selected dataset", () => {
    expect(() => runReplay(
      {
        ...manifest,
        definition: {
          ...manifest.definition,
          optionSymbols: [intent.longContractSymbol],
        },
      },
      {
        replayVersion: "1.0.0",
        execution,
        scenarios: [{
          scenarioId: "missing-proxy-leg",
          fidelity: "HISTORICAL_BAR_PROXY",
          retainedIntent: intent,
        }],
      },
    )).toThrow(/option symbols absent from the dataset/u)
  })

  it("rejects implicit proxy entry sessions outside the acquired interval", () => {
    expect(() => runReplay(
      proxyManifest,
      {
        replayVersion: "1.0.0",
        execution,
        scenarios: [{
          scenarioId: "warmup-entry",
          fidelity: "HISTORICAL_BAR_PROXY",
          retainedIntent: {
            ...intent,
            evaluatedAt: "2026-08-26T14:30:00.000Z",
            longQuote: {
              ...intent.longQuote,
              providerTimestamp: "2026-08-26T14:29:30.000Z",
            },
            shortQuote: {
              ...intent.shortQuote,
              providerTimestamp: "2026-08-26T14:29:30.000Z",
            },
          },
        }],
      },
      [{
        recordType: "MARKET_SESSION",
        date: "2026-08-26",
        open: "2026-08-26T13:30:00.000Z",
        close: "2026-08-26T20:00:00.000Z",
      }],
    )).toThrow(/entry session is outside the dataset interval/u)
  })

  it("clamps derived proxy marks to the spread width", () => {
    const timestamp = intent.evaluatedAt
    const bar = (contractSymbol: string, lowMicros: number, highMicros: number) => ({
      recordType: "OPTION_BAR" as const,
      contractSymbol,
      timeframe: "1MINUTE" as const,
      timestamp,
      openMicros: lowMicros,
      highMicros,
      lowMicros,
      closeMicros: lowMicros,
      volume: 10,
      vwapMicros: lowMicros,
      tradeCount: 1,
    })
    const cycles = deriveHistoricalBarProxyCyclesV1([
      {
        recordType: "MARKET_SESSION",
        date: "2026-08-27",
        open: "2026-08-27T13:30:00.000Z",
        close: "2026-08-27T20:00:00.000Z",
      },
      bar(intent.longContractSymbol, 6_000_000, 6_000_000),
      bar(intent.shortContractSymbol, 500_000, 500_000),
    ], intent)

    expect(cycles[0]).toMatchObject({
      decidedAt: "2026-08-27T14:31:00.000Z",
      markHalfCentsPerShare: intent.widthCentsPerShare * 2,
    })
  })

  it("carries synchronized-mark gaps into proxy stale-data exits", () => {
    const optionBar = (contractSymbol: string, timestamp: string, lowMicros: number, highMicros: number) => ({
      recordType: "OPTION_BAR" as const,
      contractSymbol,
      timeframe: "1MINUTE" as const,
      timestamp,
      openMicros: lowMicros,
      highMicros,
      lowMicros,
      closeMicros: lowMicros,
      volume: 10,
      vwapMicros: lowMicros,
      tradeCount: 1,
    })
    const session = {
      recordType: "MARKET_SESSION" as const,
      date: "2026-08-27",
      open: "2026-08-27T13:30:00.000Z",
      close: "2026-08-27T20:00:00.000Z",
    }
    const records = [
      session,
      optionBar(intent.longContractSymbol, intent.evaluatedAt, 3_000_000, 3_000_000),
      optionBar(intent.shortContractSymbol, intent.evaluatedAt, 1_000_000, 1_000_000),
      optionBar(intent.longContractSymbol, "2026-08-27T14:40:00.000Z", 1_000_000, 1_000_000),
      optionBar(intent.shortContractSymbol, "2026-08-27T14:40:00.000Z", 1_000_000, 1_000_000),
    ]
    const cycles = deriveHistoricalBarProxyCyclesV1(records, intent)

    expect(cycles.slice(0, 2).map(({ staleMinutes }) => staleMinutes)).toEqual([1, 10])
    expect(deriveHistoricalBarProxyCyclesV1(records.slice(0, 1).concat(records.slice(3)), intent)[0])
      .toMatchObject({ staleMinutes: 11 })

    const report = runReplay(
      proxyManifest,
      {
        replayVersion: "1.0.0",
        execution,
        scenarios: [{
          scenarioId: "stale-proxy-gap",
          fidelity: "HISTORICAL_BAR_PROXY",
          retainedIntent: intent,
        }],
      },
      records,
    )
    expect(report.results[0]).toMatchObject({
      exitReason: "STALE_DATA",
      exitDecidedAt: "2026-08-27T14:41:00.000Z",
    })
  })

  it("preserves a terminal stale interval as an unpriced proxy exit", () => {
    const timestamp = intent.evaluatedAt
    const optionBar = (contractSymbol: string, lowMicros: number, highMicros: number) => ({
      recordType: "OPTION_BAR" as const,
      contractSymbol,
      timeframe: "1MINUTE" as const,
      timestamp,
      openMicros: lowMicros,
      highMicros,
      lowMicros,
      closeMicros: lowMicros,
      volume: 10,
      vwapMicros: lowMicros,
      tradeCount: 1,
    })
    const records = [
      {
        recordType: "MARKET_SESSION" as const,
        date: "2026-08-27",
        open: "2026-08-27T13:30:00.000Z",
        close: "2026-08-27T20:00:00.000Z",
      },
      optionBar(intent.longContractSymbol, 3_000_000, 3_000_000),
      optionBar(intent.shortContractSymbol, 1_000_000, 1_000_000),
    ]
    const cycles = deriveHistoricalBarProxyCyclesV1(records, intent)

    expect(cycles.at(-1)).toEqual({
      decidedAt: "2026-08-27T14:36:00.000Z",
      marketOpen: true,
      lateFill: false,
      dte: 15,
      minutesToClose: 324,
      staleMinutes: 5,
      markHalfCentsPerShare: undefined,
      holdingSessionIndex: 1,
    })
    const report = runReplay(
      proxyManifest,
      {
        replayVersion: "1.0.0",
        execution,
        scenarios: [{
          scenarioId: "terminal-stale",
          fidelity: "HISTORICAL_BAR_PROXY",
          retainedIntent: intent,
        }],
      },
      records,
    )
    expect(report.results[0]).toMatchObject({
      outcome: "EXIT_UNPRICED",
      exitReason: "STALE_DATA",
      exitDecidedAt: "2026-08-27T14:36:00.000Z",
      pnlCents: null,
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

    expect(cycles[0]).toMatchObject({
      completedDailyCloseMicros: 100_000_019,
      sma20Micros: 100_000_009.5,
    })
  })

  it("reports mark-independent exits without a fabricated P&L", () => {
    const report = runReplay(manifest, {
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
