import { describe, expect, it } from "vitest"

import {
  backtestExperimentV2Schema,
  datasetManifestV2Schema,
} from "../src/backtest-v2/contracts-v2.js"
import { runBacktestV2Preflight } from "../src/backtest-v2/preflight-v2.js"

const dataset = datasetManifestV2Schema.parse({
  datasetVersion: "2.0.0",
  datasetId: "test-dataset",
  evidenceTier: "FIXTURE_SELECTION_ONLY",
  universeId: "golden-tech-options-v1",
  timezone: "America/New_York",
  startDate: "2025-01-02",
  endDate: "2025-01-03",
  coveredSymbols: ["AAPL", "AMD", "NVDA"],
  sessionDates: ["2025-01-02", "2025-01-03"],
  source: "COMMITTED_FIXTURE",
})

const experiment = backtestExperimentV2Schema.parse({
  backtestVersion: "2.0.0",
  experimentId: "test-experiment",
  capability: "SELECTION_PREFLIGHT",
  datasetManifestRef: "unused-in-pure-test.json",
  universeId: "golden-tech-options-v1",
  replaySelection: {
    startDate: "2025-01-02",
    endDate: "2025-01-03",
    timezone: "America/New_York",
    symbols: ["NVDA", "AAPL"],
    session: "REGULAR",
    decisionTimes: ["15:00", "10:00"],
  },
  strategy: {
    strategyVersion: "directional-debit-spread-v1",
    structures: ["BULL_CALL_SPREAD", "BEAR_PUT_SPREAD"],
  },
  execution: {
    priceMode: "BID_ASK",
    multiLegFill: "ATOMIC",
    missingQuote: "INCOMPLETE_RUN",
    latencyMilliseconds: 1000,
    slippageHalfCentsPerLeg: 1,
    commissionCentsPerContract: 65,
  },
  portfolio: {
    initialCapitalCents: 1_000_000,
    quantity: 1,
    maxConcurrentPositions: 1,
    endOfTest: "LIQUIDATE_AT_END",
  },
})

describe("Backtest V2 selection preflight", () => {
  it("selects dates and symbols deterministically and reports scheduled evaluations", () => {
    const report = runBacktestV2Preflight(experiment, dataset)

    expect(report.status).toBe("READY")
    expect(report.selectedSymbols).toEqual(["AAPL", "NVDA"])
    expect(report.selectedSessionDates).toEqual(["2025-01-02", "2025-01-03"])
    expect(report.decisionTimes).toEqual(["10:00", "15:00"])
    expect(report.counts.scheduledDecisionEvaluations).toBe(8)
    expect(report.warnings).toEqual([
      "PREFLIGHT_ONLY_NO_OPTION_QUOTES_FILLS_OR_PNL",
    ])
  })

  it("rejects replay dates outside dataset coverage", () => {
    const outside = {
      ...experiment,
      replaySelection: {
        ...experiment.replaySelection,
        endDate: "2025-01-04",
      },
    }

    expect(() => runBacktestV2Preflight(outside, dataset)).toThrow(
      "outside dataset coverage",
    )
  })

  it("rejects unsupported and duplicate symbols at the config boundary", () => {
    const invalid = {
      ...experiment,
      replaySelection: {
        ...experiment.replaySelection,
        symbols: ["AAPL", "AAPL", "SPY"],
      },
    }

    const result = backtestExperimentV2Schema.safeParse(invalid)
    expect(result.success).toBe(false)
  })
})
