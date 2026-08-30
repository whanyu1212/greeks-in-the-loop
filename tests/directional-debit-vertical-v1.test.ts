import { describe, expect, it } from "vitest"

import {
  buildOptionUniverseSnapshotV1,
  buildUnderlyingSessionSnapshotV1,
  validateResearchSnapshotPairV1,
  type OptionUniverseSnapshotBuildInputV1,
} from "../src/contracts/research-market-snapshot-builders-v1.js"
import { evaluateBacktestSignalV1 } from "../src/backtest/replay-v1.js"
import {
  calculateDirectionalTrendFeaturesV1,
  compareDebitVerticalCandidateRanksV1,
  createDebitVerticalCandidateRankV1,
  screenSpyDirectionalDebitVerticalV1,
} from "../src/strategy/directional-debit-vertical-v1.js"
import {
  createOptionUniverseSnapshotInputV1,
  createUnderlyingSnapshotInputV1,
} from "./fixtures/research-market-snapshot-v1.js"

type ContractInput = OptionUniverseSnapshotBuildInputV1["contracts"][number]

const contractSymbol = (
  expirationDate: string,
  optionType: "CALL" | "PUT",
  strikeCentsPerShare: number,
) =>
  `SPY${expirationDate.slice(2).replaceAll("-", "")}${
    optionType === "CALL" ? "C" : "P"
  }${String(strikeCentsPerShare * 10).padStart(8, "0")}`

const contract = ({
  expirationDate = "2026-09-18",
  optionType = "CALL",
  strikeCentsPerShare,
  deltaMillionths,
  bidCentsPerShare,
  askCentsPerShare,
  tradable = true,
  exerciseStyle = "AMERICAN",
  multiplier = 100,
  volume = 100,
  openInterest = 500,
}: Readonly<{
  expirationDate?: string
  optionType?: "CALL" | "PUT"
  strikeCentsPerShare: number
  deltaMillionths: number
  bidCentsPerShare: number
  askCentsPerShare: number
  tradable?: boolean
  exerciseStyle?: "AMERICAN" | "EUROPEAN" | "UNKNOWN"
  multiplier?: number
  volume?: number
  openInterest?: number
}>): ContractInput => ({
  contractSymbol: contractSymbol(
    expirationDate,
    optionType,
    strikeCentsPerShare,
  ),
  expirationDate,
  optionType,
  strikeCentsPerShare,
  active: true,
  tradable,
  exerciseStyle,
  multiplier,
  quote: {
    providerTimestamp: "2026-08-28T14:00:45.000Z",
    bidCentsPerShare,
    askCentsPerShare,
  },
  greeks: {
    deltaMillionths,
    gammaMillionths: 20_000,
    thetaMillionths: -100_000,
    vegaMillionths: 150_000,
    impliedVolatilityMillionths: 200_000,
  },
  currentSessionVolume: {
    sessionDate: "2026-08-28",
    providerTimestamp: "2026-08-28T14:00:00.000Z",
    contracts: volume,
  },
  openInterest: { asOfDate: "2026-08-27", contracts: openInterest },
})

const validCallPair = () => [
  contract({
    strikeCentsPerShare: 63_000,
    deltaMillionths: 500_000,
    bidCentsPerShare: 400,
    askCentsPerShare: 410,
  }),
  contract({
    strikeCentsPerShare: 63_500,
    deltaMillionths: 300_000,
    bidCentsPerShare: 150,
    askCentsPerShare: 160,
  }),
] as const

const worseDteCallPair = () => [
  contract({
    expirationDate: "2026-09-11",
    strikeCentsPerShare: 62_000,
    deltaMillionths: 500_000,
    bidCentsPerShare: 400,
    askCentsPerShare: 410,
  }),
  contract({
    expirationDate: "2026-09-11",
    strikeCentsPerShare: 62_500,
    deltaMillionths: 300_000,
    bidCentsPerShare: 150,
    askCentsPerShare: 160,
  }),
] as const

const buildPair = (
  contracts: readonly ContractInput[],
  mutateUnderlying?: (
    input: ReturnType<typeof createUnderlyingSnapshotInputV1>,
  ) => void,
) => {
  const underlyingInput = createUnderlyingSnapshotInputV1()
  underlyingInput.underlyingQuote.bidMicrosPerShare = 636_000_000
  underlyingInput.underlyingQuote.askMicrosPerShare = 636_020_000
  mutateUnderlying?.(underlyingInput)
  const underlyingResult = buildUnderlyingSessionSnapshotV1(underlyingInput)
  if (!underlyingResult.success) {
    throw new Error(underlyingResult.reasons.join(","))
  }

  const optionInput = createOptionUniverseSnapshotInputV1()
  optionInput.requestedContractSymbols.splice(
    0,
    optionInput.requestedContractSymbols.length,
    ...contracts.map(({ contractSymbol: symbol }) => symbol),
  )
  optionInput.contracts.splice(
    0,
    optionInput.contracts.length,
    ...contracts,
  )
  const optionResult = buildOptionUniverseSnapshotV1(
    underlyingResult.snapshot,
    optionInput,
  )
  if (!optionResult.success) throw new Error(optionResult.reasons.join(","))

  const pair = validateResearchSnapshotPairV1(
    underlyingResult.snapshot,
    optionResult.snapshot,
  )
  if (!pair.success) throw new Error(pair.reason)
  return pair
}

const features = (closes: readonly number[], bid: number, ask: number) =>
  calculateDirectionalTrendFeaturesV1({
    completedDailyClosesMicrosPerShare: closes,
    completedMinuteBars: [
      { vwapMicrosPerShare: 100_000_000, volume: 2 },
      { vwapMicrosPerShare: 200_000_000, volume: 1 },
    ],
    underlyingBidMicrosPerShare: bid,
    underlyingAskMicrosPerShare: ask,
  })

describe("directional debit vertical V1", () => {
  it("calculates exact symbol-neutral trend features and strict directions", () => {
    const rising = Array.from({ length: 50 }, (_, index) =>
      (index + 1) * 1_000_000,
    )
    const bullish = features(rising, 150_000_000, 152_000_000)
    expect(bullish).toEqual({
      success: true,
      features: {
        dailyCloseMicrosPerShare: 50_000_000,
        sma20: { numeratorMicrosPerShare: "810000000", denominator: 20 },
        sma50: { numeratorMicrosPerShare: "1275000000", denominator: 50 },
        sessionVwap: {
          numeratorMicrosVolume: "400000000",
          denominatorVolume: "3",
        },
        underlyingMidpoint: {
          numeratorMicrosPerShare: "302000000",
          denominator: 2,
        },
        direction: "BULLISH",
      },
    })

    const falling = [...rising].reverse()
    expect(features(falling, 50_000_000, 52_000_000)).toMatchObject({
      success: true,
      features: { direction: "BEARISH" },
    })
    expect(
      calculateDirectionalTrendFeaturesV1({
        completedDailyClosesMicrosPerShare: rising,
        completedMinuteBars: [
          { vwapMicrosPerShare: 100_000_000, volume: 1 },
        ],
        underlyingBidMicrosPerShare: 100_000_000,
        underlyingAskMicrosPerShare: 100_000_000,
      }),
    ).toMatchObject({ success: true, features: { direction: "NO_ACTION" } })
    expect(features(rising.slice(1), 150_000_000, 152_000_000)).toEqual({
      success: false,
      reason: "FEATURE_INPUT_INVALID",
    })
  })

  it("shares feature calculation with replay without changing its output shape", () => {
    const closes = Array.from({ length: 50 }, (_, index) =>
      (index + 1) * 1_000_000,
    )
    expect(
      evaluateBacktestSignalV1({
        sessionDate: "2026-08-28",
        observedAt: "2026-08-28T14:00:00.000Z",
        precedingSessionDates: Array.from({ length: 50 }, (_, index) =>
          new Date(Date.UTC(2026, 5, 1 + index)).toISOString().slice(0, 10),
        ),
        completedDailyBars: closes.map((closeMicros, index) => ({
          feed: "IEX" as const,
          adjustment: "all" as const,
          sessionDate: new Date(Date.UTC(2026, 5, 1 + index))
            .toISOString()
            .slice(0, 10),
          closeMicros,
        })),
        completedMinuteBars: Array.from({ length: 30 }, (_, index) => ({
          feed: "IEX" as const,
          startedAt: new Date(
            Date.parse("2026-08-28T13:30:00.000Z") + index * 60_000,
          ).toISOString(),
          vwapMicros: 100_000_000,
          volume: 1,
        })),
        underlyingQuote: {
          feed: "IEX",
          providerTimestamp: "2026-08-28T14:00:00.000Z",
          bidMicros: 150_000_000,
          askMicros: 152_000_000,
        },
      }),
    ).toEqual({
      direction: "BULLISH",
      dailyCloseMicros: 50_000_000,
      sma20Micros: 40_500_000,
      sma50Micros: 25_500_000,
      sessionVwapMicros: 100_000_000,
      spotMidpointMicros: 151_000_000,
    })
  })

  it("applies every candidate rank tie-breaker in order", () => {
    const rank = (
      overrides: Partial<Parameters<typeof createDebitVerticalCandidateRankV1>[0]> = {},
    ) =>
      createDebitVerticalCandidateRankV1({
        dte: 21,
        longDeltaMillionths: 500_000,
        shortDeltaMillionths: 300_000,
        widthCentsPerShare: 500,
        expirationDate: "2026-09-18",
        longContractSymbol: "SPY260918C00630000",
        shortContractSymbol: "SPY260918C00635000",
        ...overrides,
      })

    const ordered = [
      rank({ longContractSymbol: "SPY260918C00630001" }),
      rank({ expirationDate: "2026-09-19" }),
      rank({ widthCentsPerShare: 600 }),
      rank({ longDeltaMillionths: 510_000 }),
      rank({ dte: 22 }),
      rank(),
    ].sort(compareDebitVerticalCandidateRanksV1)
    expect(ordered).toEqual([
      rank(),
      rank({ longContractSymbol: "SPY260918C00630001" }),
      rank({ expirationDate: "2026-09-19" }),
      rank({ widthCentsPerShare: 600 }),
      rank({ longDeltaMillionths: 510_000 }),
      rank({ dte: 22 }),
    ])
  })

  it("selects one deterministic candidate and binds its identity to snapshots", () => {
    const contracts = [...validCallPair(), ...worseDteCallPair()]
    const baseline = screenSpyDirectionalDebitVerticalV1(
      buildPair(contracts),
    )
    expect(baseline).toMatchObject({
      status: "SELECTED",
      eligibleCandidateCount: 2,
      selectedCandidate: {
        contractVersion: "1.0.0",
        strategyId: "spy-directional-debit-vertical",
        strategyVersion: "1.1.0",
        featureComponentId: "calculateDirectionalTrendFeaturesV1",
        featureVersion: "1.0.0",
        candidateComponentId: "screenSpyDirectionalDebitVerticalV1",
        candidateVersion: "1.0.0",
        underlying: "SPY",
        direction: "BULLISH",
        structure: "BULL_CALL_SPREAD",
        expirationDate: "2026-09-18",
        dte: 21,
        longLeg: {
          role: "LONG",
          contractSymbol: "SPY260918C00630000",
        },
        shortLeg: {
          role: "SHORT",
          contractSymbol: "SPY260918C00635000",
        },
        economics: {
          entryLimitCentsPerShare: 250,
          widthCentsPerShare: 500,
          maxLossCentsPerContract: 25_000,
          maxProfitCentsPerContract: 25_000,
        },
      },
    })
    if (baseline.status !== "SELECTED") return
    expect(baseline.selectedCandidate.candidateId).toBe(
      "926f907fb4be051b2908251bbcf73b30ecbe5c98561b8f8788f30dad57c7d2f5",
    )
    expect([
      baseline,
      baseline.features,
      baseline.selectedCandidate,
      baseline.selectedCandidate.longLeg,
      baseline.selectedCandidate.shortLeg,
      baseline.selectedCandidate.economics,
      baseline.selectedCandidate.rank,
    ].every(Object.isFrozen)).toBe(true)

    const reordered = screenSpyDirectionalDebitVerticalV1(
      buildPair([...contracts].reverse()),
    )
    expect(reordered).toEqual(baseline)

    const changed = screenSpyDirectionalDebitVerticalV1(
      buildPair(contracts, (input) => {
        input.underlyingQuote.bidMicrosPerShare += 1
      }),
    )
    expect(changed.status).toBe("SELECTED")
    if (changed.status === "SELECTED") {
      expect(changed.selectedCandidate.rank).toEqual(
        baseline.selectedCandidate.rank,
      )
      expect(changed.selectedCandidate.candidateId).not.toBe(
        baseline.selectedCandidate.candidateId,
      )
    }
  })

  it("constructs the bearish put structure from the same feature engine", () => {
    const result = screenSpyDirectionalDebitVerticalV1(
      buildPair(
        [
          contract({
            optionType: "PUT",
            strikeCentsPerShare: 64_000,
            deltaMillionths: -500_000,
            bidCentsPerShare: 400,
            askCentsPerShare: 410,
          }),
          contract({
            optionType: "PUT",
            strikeCentsPerShare: 63_500,
            deltaMillionths: -300_000,
            bidCentsPerShare: 150,
            askCentsPerShare: 160,
          }),
        ],
        (input) => {
          input.dailyBars.forEach((bar, index) => {
            const close = 640_000_000 - index * 100_000
            Object.assign(bar, {
              openMicrosPerShare: close,
              highMicrosPerShare: close + 100_000,
              lowMicrosPerShare: close - 100_000,
              closeMicrosPerShare: close,
              vwapMicrosPerShare: close,
            })
          })
          input.underlyingQuote.bidMicrosPerShare = 634_000_000
          input.underlyingQuote.askMicrosPerShare = 634_020_000
        },
      ),
    )
    expect(result).toMatchObject({
      status: "SELECTED",
      selectedCandidate: {
        direction: "BEARISH",
        structure: "BEAR_PUT_SPREAD",
        longLeg: { contractSymbol: "SPY260918P00640000" },
        shortLeg: { contractSymbol: "SPY260918P00635000" },
      },
    })
  })

  it("accepts inclusive contract and economics boundaries", () => {
    const result = screenSpyDirectionalDebitVerticalV1(
      buildPair([
        contract({
          strikeCentsPerShare: 63_000,
          deltaMillionths: 600_000,
          bidCentsPerShare: 700,
          askCentsPerShare: 720,
          volume: 100,
          openInterest: 500,
        }),
        contract({
          strikeCentsPerShare: 64_000,
          deltaMillionths: 350_000,
          bidCentsPerShare: 200,
          askCentsPerShare: 220,
          volume: 100,
          openInterest: 500,
        }),
      ]),
    )
    expect(result).toMatchObject({
      status: "SELECTED",
      selectedCandidate: {
        economics: {
          entryLimitCentsPerShare: 500,
          widthCentsPerShare: 1_000,
          maxLossCentsPerContract: 50_000,
        },
      },
    })
  })

  it.each([
    [
      "long delta",
      [
        contract({
          strikeCentsPerShare: 63_000,
          deltaMillionths: 449_999,
          bidCentsPerShare: 400,
          askCentsPerShare: 410,
        }),
        validCallPair()[1],
      ],
    ],
    [
      "short delta",
      [
        validCallPair()[0],
        contract({
          strikeCentsPerShare: 63_500,
          deltaMillionths: 350_001,
          bidCentsPerShare: 150,
          askCentsPerShare: 160,
        }),
      ],
    ],
    [
      "relative quote width",
      [
        contract({
          strikeCentsPerShare: 63_000,
          deltaMillionths: 500_000,
          bidCentsPerShare: 100,
          askCentsPerShare: 111,
        }),
        validCallPair()[1],
      ],
    ],
    [
      "volume",
      [validCallPair()[0], { ...validCallPair()[1], currentSessionVolume: {
        ...validCallPair()[1].currentSessionVolume,
        contracts: 99,
      } }],
    ],
    [
      "open interest",
      [validCallPair()[0], { ...validCallPair()[1], openInterest: {
        ...validCallPair()[1].openInterest,
        contracts: 499,
      } }],
    ],
    [
      "contract metadata",
      [validCallPair()[0], { ...validCallPair()[1], exerciseStyle: "EUROPEAN" as const }],
    ],
    [
      "debit cap",
      [
        contract({
          strikeCentsPerShare: 63_000,
          deltaMillionths: 500_000,
          bidCentsPerShare: 500,
          askCentsPerShare: 510,
        }),
        contract({
          strikeCentsPerShare: 63_500,
          deltaMillionths: 300_000,
          bidCentsPerShare: 190,
          askCentsPerShare: 200,
        }),
      ],
    ],
    [
      "maximum loss",
      [
        contract({
          strikeCentsPerShare: 63_000,
          deltaMillionths: 500_000,
          bidCentsPerShare: 800,
          askCentsPerShare: 820,
        }),
        contract({
          strikeCentsPerShare: 64_000,
          deltaMillionths: 300_000,
          bidCentsPerShare: 299,
          askCentsPerShare: 319,
        }),
      ],
    ],
  ] satisfies readonly (readonly [string, readonly ContractInput[]])[])(
    "rejects a candidate outside the %s boundary",
    (_label, contracts) => {
      expect(
        screenSpyDirectionalDebitVerticalV1(buildPair(contracts)),
      ).toMatchObject({ status: "NO_ACTION", reason: "NO_ELIGIBLE_SPREAD" })
    },
  )

  it("distinguishes neutral signals and evaluation-time staleness", () => {
    expect(
      screenSpyDirectionalDebitVerticalV1(
        buildPair(validCallPair(), (input) => {
          input.underlyingQuote.bidMicrosPerShare = 635_190_000
          input.underlyingQuote.askMicrosPerShare = 635_200_000
        }),
      ),
    ).toMatchObject({ status: "NO_ACTION", reason: "SIGNAL_NOT_ACTIONABLE" })

    expect(
      screenSpyDirectionalDebitVerticalV1(
        buildPair(validCallPair(), (input) => {
          input.times.evaluatedAt = "2026-08-28T14:01:31.000Z"
        }),
      ),
    ).toMatchObject({ status: "NO_ACTION", reason: "MARKET_DATA_STALE" })
  })

})
