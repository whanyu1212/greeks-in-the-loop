import { describe, expect, it } from "vitest"

import {
  backtestDatasetDefinitionV2Schema,
  computeBacktestDatasetIdV2,
  createBacktestDatasetDefinitionV2,
  expectedBacktestPartitionKeysV2,
  parseBacktestDatasetRecordV2,
} from "../src/backtest/dataset-v2.js"
import { canonicalJsonSha256 } from "../src/shared/canonical-json.js"
import {
  createBacktestDatasetDefinitionV2Fixture,
  createSyntheticStrategyManifest,
} from "./fixtures/backtest-dataset-v2.js"

describe("Backtest Dataset V2", () => {
  it("derives deterministic immutable identity from acquisition scope", () => {
    const first = createBacktestDatasetDefinitionV2Fixture()
    const laterRequest = createBacktestDatasetDefinitionV2Fixture({
      requestStartedAt: "2024-06-05T11:00:00.000Z",
    })

    expect(first.datasetId).toBe(laterRequest.datasetId)
    expect(first.datasetId).toHaveLength(64)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.strategyManifest)).toBe(true)
    expect(Object.isFrozen(first.optionSymbols)).toBe(true)

    const { datasetId, ...content } = first
    expect(datasetId).toBe(computeBacktestDatasetIdV2(content))
  })

  it("rejects tampered identity, manifest drift, and mixed option roots", () => {
    const definition = createBacktestDatasetDefinitionV2Fixture()
    expect(
      backtestDatasetDefinitionV2Schema.safeParse({
        ...definition,
        datasetId: "a".repeat(64),
      }).success,
    ).toBe(false)
    expect(
      backtestDatasetDefinitionV2Schema.safeParse({
        ...definition,
        datasetVersion: "9.9.9",
      }).success,
    ).toBe(false)

    const qqqManifest = createSyntheticStrategyManifest("QQQ")
    expect(() =>
      createBacktestDatasetDefinitionV2({
        strategyManifest: qqqManifest,
        fromDate: definition.fromDate,
        toDate: definition.toDate,
        optionSymbols: [
          "QQQ240621C00450000",
          "SPY240621C00530000",
        ],
        requestStartedAt: definition.requestStartedAt,
      })
    ).toThrow()
  })

  it("is structurally symbol-neutral without registering another strategy", () => {
    const definition = createBacktestDatasetDefinitionV2Fixture({
      strategyManifest: createSyntheticStrategyManifest("QQQ"),
      optionSymbols: [
        "QQQ240621C00450000",
        "QQQ240621C00455000",
      ],
    })

    expect(definition.symbol).toBe("QQQ")
    expect(backtestDatasetDefinitionV2Schema.parse(definition)).toEqual(
      definition,
    )
    expect(expectedBacktestPartitionKeysV2(definition)).toEqual([
      "calendar",
      "underlying-daily",
      "underlying-minute",
      "contracts-active",
      "contracts-inactive",
      expect.stringMatching(/^option-bars-1day-/u),
      expect.stringMatching(/^option-bars-1minute-/u),
      expect.stringMatching(/^option-trades-/u),
    ])
  })

  it("context-validates underlying and redundant OCC contract identity", () => {
    const definition = createBacktestDatasetDefinitionV2Fixture()
    expect(() =>
      parseBacktestDatasetRecordV2(definition, {
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
      })
    ).toThrow("does not match")

    expect(() =>
      parseBacktestDatasetRecordV2(definition, {
        recordType: "OPTION_BAR",
        contractSymbol: "SPY240621C00540000",
        timeframe: "1MINUTE",
        timestamp: "2024-06-03T13:30:00.000Z",
        openMicros: 1,
        highMicros: 1,
        lowMicros: 1,
        closeMicros: 1,
        volume: 1,
        vwapMicros: 1,
        tradeCount: 1,
      })
    ).toThrow("outside the retained scope")

    expect(() =>
      parseBacktestDatasetRecordV2(definition, {
        recordType: "OPTION_CONTRACT",
        contractSymbol: "SPY240621C00530000",
        expirationDate: "2024-06-21",
        optionType: "PUT",
        strikeCentsPerShare: 53_000,
        active: true,
        tradable: true,
        exerciseStyle: "AMERICAN",
        multiplier: 100,
        retrievedAt: "2024-06-05T10:00:00.000Z",
      })
    ).toThrow("inconsistent")
  })

  it("preserves fixed V1 canonical identity independently of V2", async () => {
    const { backtestDatasetDefinitionV1Schema } = await import(
      "../src/backtest/dataset-v1.js"
    )
    const legacy = backtestDatasetDefinitionV1Schema.parse({
      datasetVersion: "1.0.0",
      normalizationVersion: "1.0.0",
      datasetId: "spy-golden-v1",
      symbol: "SPY",
      fromDate: "2024-02-01",
      toDate: "2024-02-02",
      optionHistoricalFeed: "ALPACA_ACCOUNT_DEFAULT",
      optionSymbols: [
        "SPY240216C00500000",
        "SPY240216C00505000",
      ],
      requestStartedAt: "2026-08-27T10:00:00.000Z",
    })
    expect(canonicalJsonSha256(legacy)).toBe(
      "e984ec913af96f346346c71b0f8a803c0c4afac157577d80c0ac6d76f9d2ba42",
    )
  })
})
