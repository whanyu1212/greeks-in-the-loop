import { readFileSync, rmSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"

import {
  historicalReplayExperimentV2Schema,
  historicalSourceV2Schema,
} from "../src/backtest-v2/historical-contracts-v2.js"
import { runHistoricalReplayV2 } from "../src/backtest-v2/historical-replay-v2.js"
import { ingestHistoricalSourceV2 } from "../src/backtest-v2/historical-store-v2.js"

describe("Backtest V2 historical ingestion and replay", () => {
  it("rejects duplicate decisions and signals outside the replay selection", () => {
    const rawExperiment = JSON.parse(readFileSync(
      "config/backtest-v2/historical-smoke.json",
      "utf8",
    )) as Record<string, unknown>
    const signals = rawExperiment.signals as Record<string, unknown>[]
    const signal = signals[0]
    if (signal === undefined) throw new Error("Historical smoke signal is missing")

    const duplicate = historicalReplayExperimentV2Schema.safeParse({
      ...rawExperiment,
      signals: [signal, { ...signal }],
    })
    expect(duplicate.success).toBe(false)
    if (!duplicate.success) {
      expect(duplicate.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ["signals", 1, "decisionId"], message: "duplicate decisionId" }),
      ]))
    }

    for (const [field, value] of [
      ["decisionAt", "2025-01-01T15:00:00.000-05:00"],
      ["exitAt", "2025-01-04T15:00:00.000-05:00"],
    ] as const) {
      const parsed = historicalReplayExperimentV2Schema.safeParse({
        ...rawExperiment,
        signals: [{ ...signal, [field]: value }],
      })
      expect(parsed.success).toBe(false)
      if (!parsed.success) {
        expect(parsed.error.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: ["signals", 0, field], message: `${field} is outside replay selection` }),
        ]))
      }
    }
  })

  it("ingests immutable mapped data, reconstructs a chain, and stores P&L lineage", () => {
    const directory = mkdtempSync(join(tmpdir(), "backtest-v2-historical-"))
    try {
      const databasePath = join(directory, "historical.sqlite")
      const source = historicalSourceV2Schema.parse(JSON.parse(readFileSync(
        "fixtures/backtest-v2/historical-smoke-source.json",
        "utf8",
      )) as unknown)
      const manifest = ingestHistoricalSourceV2(databasePath, source)
      expect(manifest.counts).toEqual({
        sessions: 2,
        underlyingBars: 2,
        contracts: 2,
        quotes: 6,
        partitions: 4,
      })
      expect(ingestHistoricalSourceV2(databasePath, source).sourceHash).toBe(manifest.sourceHash)

      const rawExperiment = JSON.parse(readFileSync(
        "config/backtest-v2/historical-smoke.json",
        "utf8",
      )) as Record<string, unknown>
      const experiment = historicalReplayExperimentV2Schema.parse({
        ...rawExperiment,
        databasePath,
      })
      const outputDirectory = join(directory, "run")
      const report = runHistoricalReplayV2(experiment, outputDirectory)
      expect(report.status).toBe("COMPLETE")
      expect(report.selectedSpreads).toBe(1)
      expect(report.openedPositions).toBe(1)
      expect(report.closedPositions).toBe(1)
      expect(report.totalFeesCents).toBe(260)
      expect(report.netPnlCents).toBe(9_540)
      expect(report.endingEquityCents).toBe(1_009_540)

      const runDatabase = new Database(report.runLedgerPath, { readonly: true })
      try {
        const run = runDatabase.prepare(
          "SELECT status, ending_equity_cents, net_pnl_cents, terminal_event_hash FROM backtest_runs",
        ).get() as { status: string; ending_equity_cents: number; net_pnl_cents: number; terminal_event_hash: string }
        expect(run).toMatchObject({
          status: "COMPLETE",
          ending_equity_cents: 1_009_540,
          net_pnl_cents: 9_540,
        })
        expect(run.terminal_event_hash).toMatch(/^[a-f0-9]{64}$/)
        expect((runDatabase.prepare("SELECT COUNT(*) AS count FROM fills").get() as { count: number }).count).toBe(2)
        expect((runDatabase.prepare("SELECT realized_pnl_cents, exit_reason FROM positions").get() as { realized_pnl_cents: number; exit_reason: string })).toEqual({
          realized_pnl_cents: 9_540,
          exit_reason: "PROFIT_TARGET",
        })
        expect((runDatabase.prepare("SELECT metric_value_integer FROM backtest_metrics WHERE metric_name = 'NET_PNL_CENTS'").get() as { metric_value_integer: number }).metric_value_integer).toBe(9_540)
      } finally {
        runDatabase.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("does not publish equity or P&L when an open position cannot be priced", () => {
    const directory = mkdtempSync(join(tmpdir(), "backtest-v2-unpriced-"))
    try {
      const databasePath = join(directory, "historical.sqlite")
      const rawSource = JSON.parse(readFileSync(
        "fixtures/backtest-v2/historical-smoke-source.json",
        "utf8",
      )) as Record<string, unknown>
      const source = historicalSourceV2Schema.parse({
        ...rawSource,
        quotes: (rawSource.quotes as { quoteId: string }[]).filter(
          (quote) => !quote.quoteId.endsWith("-exit"),
        ),
      })
      ingestHistoricalSourceV2(databasePath, source)
      const rawExperiment = JSON.parse(readFileSync(
        "config/backtest-v2/historical-smoke.json",
        "utf8",
      )) as Record<string, unknown>
      const experiment = historicalReplayExperimentV2Schema.parse({
        ...rawExperiment,
        databasePath,
      })

      const report = runHistoricalReplayV2(experiment, join(directory, "run"))
      expect(report).toMatchObject({
        status: "INCOMPLETE",
        openedPositions: 1,
        closedPositions: 0,
        endingEquityCents: null,
        netPnlCents: null,
      })

      const runDatabase = new Database(report.runLedgerPath, { readonly: true })
      try {
        expect(runDatabase.prepare(
          "SELECT ending_equity_cents, net_pnl_cents FROM backtest_runs",
        ).get()).toEqual({ ending_equity_cents: null, net_pnl_cents: null })
        expect(runDatabase.prepare(
          "SELECT metric_value_integer FROM backtest_metrics WHERE metric_name = 'NET_PNL_CENTS'",
        ).get()).toEqual({ metric_value_integer: null })
      } finally {
        runDatabase.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
