import { describe, expect, it } from "vitest"

import {
  backtestDatasetDefinitionV1Schema,
  backtestDatasetRecordV1Schema,
  backtestOptionChunkId,
  expectedBacktestPartitionKeys,
} from "../src/backtest/dataset-v1.js"

const optionSymbols = [
  "SPY240216C00500000",
  "SPY240216C00505000",
] as const
const definition = {
  datasetVersion: "1.0.0",
  normalizationVersion: "1.0.0",
  datasetId: "spy-golden-v1",
  symbol: "SPY",
  fromDate: "2024-02-01",
  toDate: "2024-02-02",
  optionHistoricalFeed: "ALPACA_ACCOUNT_DEFAULT",
  optionSymbols,
  requestStartedAt: "2026-08-27T10:00:00.000Z",
} as const

const optionRecords = [
  {
    recordType: "OPTION_CONTRACT",
    contractSymbol: optionSymbols[0],
    expirationDate: "2024-02-16",
    optionType: "CALL",
    strikeCentsPerShare: 50_000,
    active: false,
    tradable: true,
    exerciseStyle: "AMERICAN",
    multiplier: 100,
    retrievedAt: "2026-08-27T10:00:00.000Z",
    openInterest: 700,
    openInterestDate: "2024-02-15",
  },
  {
    recordType: "OPTION_BAR",
    contractSymbol: optionSymbols[0],
    timeframe: "1MINUTE",
    timestamp: "2024-02-01T15:00:00.000Z",
    openMicros: 2_400_000,
    highMicros: 2_600_000,
    lowMicros: 2_300_000,
    closeMicros: 2_500_000,
    volume: 10,
    vwapMicros: 2_500_000,
    tradeCount: 4,
  },
  {
    recordType: "OPTION_TRADE",
    contractSymbol: optionSymbols[0],
    timestamp: "2024-02-01T15:00:00.000Z",
    priceMicros: 2_500_000,
    size: 3,
    tradeId: "trade-1",
    exchange: "C",
    conditions: ["S"],
  },
] as const

describe("Backtest dataset v1 option identity", () => {
  it("preserves the complete normalized SPY definition", () => {
    expect(backtestDatasetDefinitionV1Schema.parse(definition)).toEqual(
      definition,
    )
  })

  it.each(optionRecords)("accepts a normalized $recordType record", (record) => {
    expect(backtestDatasetRecordV1Schema.safeParse(record).success).toBe(true)
  })

  it.each(optionRecords)(
    "rejects a non-SPY $recordType record",
    (record) => {
      expect(
        backtestDatasetRecordV1Schema.safeParse({
          ...record,
          contractSymbol: "QQQ240216C00500000",
        }).success,
      ).toBe(false)
    },
  )

  it("rejects unsupported dataset identity without generalizing the underlying", () => {
    expect(
      backtestDatasetDefinitionV1Schema.safeParse({
        ...definition,
        optionSymbols: ["QQQ240216C00500000"],
      }).success,
    ).toBe(false)
    expect(
      backtestDatasetDefinitionV1Schema.safeParse({
        ...definition,
        symbol: "QQQ",
      }).success,
    ).toBe(false)
    expect(
      backtestDatasetDefinitionV1Schema.safeParse({
        ...definition,
        optionSymbols: ["SPY240231C00500000"],
      }).success,
    ).toBe(false)
  })

  it("preserves chunk identity and partition ordering", () => {
    const parsed = backtestDatasetDefinitionV1Schema.parse(definition)

    expect(backtestOptionChunkId(optionSymbols)).toBe("aa52bc7624acce36")
    expect(expectedBacktestPartitionKeys(parsed)).toEqual([
      "calendar",
      "spy-daily",
      "spy-minute",
      "contracts-active",
      "contracts-inactive",
      "option-bars-1day-aa52bc7624acce36",
      "option-bars-1minute-aa52bc7624acce36",
      "option-trades-aa52bc7624acce36",
    ])
  })

  it("preserves the unique sorted option-symbol requirement", () => {
    expect(
      backtestDatasetDefinitionV1Schema.safeParse({
        ...definition,
        optionSymbols: [optionSymbols[1], optionSymbols[0]],
      }).success,
    ).toBe(false)
    expect(
      backtestDatasetDefinitionV1Schema.safeParse({
        ...definition,
        optionSymbols: [optionSymbols[0], optionSymbols[0]],
      }).success,
    ).toBe(false)
  })
})
