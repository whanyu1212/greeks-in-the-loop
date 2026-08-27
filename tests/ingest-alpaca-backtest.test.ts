import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it, vi } from "vitest"

import { ingestAlpacaBacktestDataset } from "../src/backtest/ingest-alpaca.js"
import { createBacktestDatasetStore } from "../src/backtest/sqlite-dataset-store.js"
import type { AlpacaHistoricalClient } from "../src/market-data/alpaca-historical-client.js"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true })
})

describe("Alpaca backtest ingestion", () => {
  it("warms up daily signals, resumes pagination, and skips immutable partitions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "backtest-ingest-"))
    directories.push(directory)
    const store = createBacktestDatasetStore({
      path: join(directory, "dataset.sqlite"),
      definition: {
        datasetVersion: "1.0.0",
        normalizationVersion: "1.0.0",
        datasetId: "fixture",
        symbol: "SPY",
        fromDate: "2024-06-03",
        toDate: "2024-06-04",
        optionHistoricalFeed: "ALPACA_ACCOUNT_DEFAULT",
        createdAt: "2024-06-05T10:00:00.000Z",
      },
    })
    const dailyTokens: (string | undefined)[] = []
    const client: AlpacaHistoricalClient = {
      getCalendar: vi.fn().mockResolvedValue([]),
      getUnderlyingBarsPage: vi.fn(async ({ timeframe, fromDate, pageToken }) => {
        if (timeframe === "1DAY") {
          expect(fromDate).toBe("2024-03-05")
          dailyTokens.push(pageToken)
          return pageToken === undefined
            ? { records: [], nextPageToken: "daily-page-2" }
            : { records: [] }
        }
        expect(fromDate).toBe("2024-06-03")
        return { records: [] }
      }),
      getOptionContractsPage: vi.fn().mockResolvedValue({ records: [] }),
      getOptionBarsPage: vi.fn().mockResolvedValue({ records: [] }),
      getOptionTradesPage: vi.fn().mockResolvedValue({ records: [] }),
    }
    const input = {
      store,
      client,
      signal: new AbortController().signal,
      now: () => new Date("2024-06-05T10:00:00.000Z"),
    }

    const first = await ingestAlpacaBacktestDataset(input)
    expect(first.complete).toBe(true)
    expect(first.partitions).toHaveLength(5)
    expect(dailyTokens).toEqual([undefined, "daily-page-2"])
    expect(client.getCalendar).toHaveBeenCalledWith(
      expect.objectContaining({ fromDate: "2024-03-05" }),
    )

    await ingestAlpacaBacktestDataset(input)
    expect(dailyTokens).toEqual([undefined, "daily-page-2"])
    expect(client.getCalendar).toHaveBeenCalledTimes(1)
    store.close()
  })

  it("rejects a range that may contain partial current-session data", async () => {
    const directory = mkdtempSync(join(tmpdir(), "backtest-ingest-"))
    directories.push(directory)
    const store = createBacktestDatasetStore({
      path: join(directory, "dataset.sqlite"),
      definition: {
        datasetVersion: "1.0.0",
        normalizationVersion: "1.0.0",
        datasetId: "current-day",
        symbol: "SPY",
        fromDate: "2024-06-05",
        toDate: "2024-06-05",
        optionHistoricalFeed: "ALPACA_ACCOUNT_DEFAULT",
        createdAt: "2024-06-05T10:00:00.000Z",
      },
    })
    const unused = vi.fn().mockResolvedValue([])
    const client = {
      getCalendar: unused,
    } as unknown as AlpacaHistoricalClient

    await expect(
      ingestAlpacaBacktestDataset({
        store,
        client,
        signal: new AbortController().signal,
        now: () => new Date("2024-06-05T10:00:00.000Z"),
      }),
    ).rejects.toThrow("fully completed historical dates")
    expect(unused).not.toHaveBeenCalled()
    store.close()
  })
})
