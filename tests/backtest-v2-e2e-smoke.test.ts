import { readFileSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"

import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"

const output = `workspace/backtest-v2/e2e/test-${process.pid}`

describe("Backtest V2 minimal E2E smoke", () => {
  it("collects, seals, replays, and reconciles fixture P&L", () => {
    try {
      const result = spawnSync(process.execPath, [
        "--import",
        "tsx",
        "src/backtest-v2/live-collection/e2e-smoke-cli.ts",
        "--reset",
        "--output",
        output,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      })
      expect(result.status, result.stderr).toBe(0)
      const summary = JSON.parse(
        readFileSync(`${output}/e2e-summary.json`, "utf8"),
      ) as {
        evidenceTier: string
        status: string
        collection: { polls: number; quoteObservations: number }
        replay: {
          netPnlCents: number
          openedPositions: number
          closedPositions: number
          runLedgerPath: string
        }
      }
      expect(summary).toMatchObject({
        evidenceTier: "TEST_FIXTURE_REPLAY",
        status: "COMPLETE",
        collection: { polls: 10, quoteObservations: 20 },
        replay: {
          netPnlCents: 9_540,
          openedPositions: 1,
          closedPositions: 1,
        },
      })
      const run = new Database(summary.replay.runLedgerPath, { readonly: true })
      try {
        expect(run.pragma("integrity_check", { simple: true })).toBe("ok")
        expect(run.prepare(`
          SELECT purpose, net_price_half_cents, fees_cents
          FROM fills ORDER BY occurred_at
        `).all()).toEqual([
          { purpose: "OPEN", net_price_half_cents: 602, fees_cents: 130 },
          { purpose: "CLOSE", net_price_half_cents: 798, fees_cents: 130 },
        ])
      } finally {
        run.close()
      }
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })
})
