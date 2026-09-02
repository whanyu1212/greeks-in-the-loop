import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  parseBacktestV2CliOptions,
  runBacktestV2Cli,
} from "../src/backtest-v2/backtest-v2-cli.js"

describe("Backtest V2 CLI", () => {
  it("parses strict CLI options", () => {
    expect(parseBacktestV2CliOptions(["--config", "config.json"])).toEqual({
      configPath: "config.json",
    })
    expect(() =>
      parseBacktestV2CliOptions(["--config", "config.json", "--ticker", "AAPL"]),
    ).toThrow("Unknown option")
  })

  it("runs the committed smoke configuration and writes deterministic artifacts", () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), "backtest-v2-cli-"))
    try {
      runBacktestV2Cli({
        configPath: "config/backtest-v2/smoke.json",
        outputDirectory,
      })
      const report = JSON.parse(
        readFileSync(join(outputDirectory, "summary.json"), "utf8"),
      ) as { status: string; counts: { scheduledDecisionEvaluations: number } }
      expect(report.status).toBe("READY")
      expect(report.counts.scheduledDecisionEvaluations).toBe(2)
      expect(readFileSync(join(outputDirectory, "config-resolved.json"), "utf8"))
        .toContain('"experimentId": "golden-smoke-v1"')
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true })
    }
  })

  it("does not overwrite a historical config in the output directory", () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), "backtest-v2-cli-input-"))
    try {
      const configPath = join(outputDirectory, "config-resolved.json")
      const config = readFileSync("config/backtest-v2/historical-smoke.json", "utf8")
      writeFileSync(configPath, config)

      expect(() => runBacktestV2Cli({ configPath, outputDirectory }))
        .toThrow("Backtest V2 output must not overwrite an input")
      expect(readFileSync(configPath, "utf8")).toBe(config)
      expect(existsSync(join(outputDirectory, "run.sqlite"))).toBe(false)
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true })
    }
  })
})
