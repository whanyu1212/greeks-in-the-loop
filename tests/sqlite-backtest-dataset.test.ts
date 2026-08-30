import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { BacktestDatasetDefinitionV1 } from "../src/backtest/dataset-v1.js"
import { createBacktestDatasetStore } from "../src/backtest/sqlite-dataset-store.js"
import { createBacktestDatasetDefinitionV2Fixture } from "./fixtures/backtest-dataset-v2.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const definition: BacktestDatasetDefinitionV1 = {
  datasetVersion: "1.0.0",
  normalizationVersion: "1.0.0",
  datasetId: "spy-test-v1",
  symbol: "SPY",
  fromDate: "2024-02-01",
  toDate: "2024-02-02",
  optionHistoricalFeed: "ALPACA_ACCOUNT_DEFAULT",
  optionSymbols: [],
  requestStartedAt: "2026-08-27T10:00:00.000Z",
}

const createPath = () => {
  const root = mkdtempSync(join(tmpdir(), "backtest-dataset-"))
  roots.push(root)
  return join(root, "nested", "dataset.sqlite")
}

describe("SQLite backtest dataset", () => {
  it("resumes pages and seals a deterministic immutable partition", () => {
    const path = createPath()
    const store = createBacktestDatasetStore({ path, definition })
    const request = {
      endpoint: "/v2/calendar",
      parameters: { start: "2024-02-01", end: "2024-02-02" },
    }
    store.beginPartition({
      partitionKey: "calendar",
      kind: "MARKET_CALENDAR",
      request,
      updatedAt: "2026-08-27T10:00:00.000Z",
    })
    const first = store.appendPage({
      partitionKey: "calendar",
      records: [
        {
          recordType: "MARKET_SESSION",
          date: "2024-02-01",
          open: "2024-02-01T14:30:00.000Z",
          close: "2024-02-01T21:00:00.000Z",
        },
      ],
      nextPageToken: "page-2",
      updatedAt: "2026-08-27T10:00:01.000Z",
    })
    expect(first).toMatchObject({ pageCount: 1, rowCount: 1, nextPageToken: "page-2" })
    store.close()

    const resumed = createBacktestDatasetStore({ path, definition })
    resumed.appendPage({
      partitionKey: "calendar",
      expectedPageToken: "page-2",
      records: [
        {
          recordType: "MARKET_SESSION",
          date: "2024-02-02",
          open: "2024-02-02T14:30:00.000Z",
          close: "2024-02-02T21:00:00.000Z",
        },
      ],
      updatedAt: "2026-08-27T10:00:02.000Z",
    })
    const completed = resumed.completePartition(
      "calendar",
      "2026-08-27T10:00:03.000Z",
    )
    expect(completed.status).toBe("COMPLETE")
    expect(completed.checksum).toMatch(/^[a-f0-9]{64}$/u)
    expect(resumed.manifest()).toMatchObject({ complete: false })
    expect(resumed.listRecords()).toHaveLength(2)
    expect(() =>
      resumed.appendPage({
        partitionKey: "calendar",
        records: [],
        updatedAt: "2026-08-27T10:00:04.000Z",
      }),
    ).toThrow("immutable")
    resumed.close()
  })

  it("rejects changed requests, page tokens, and retained record conflicts", () => {
    const store = createBacktestDatasetStore({ path: createPath(), definition })
    store.beginPartition({
      partitionKey: "spy-daily",
      kind: "UNDERLYING_DAILY_BARS",
      request: { endpoint: "/bars", parameters: { timeframe: "1Day" } },
      updatedAt: "2026-08-27T10:00:00.000Z",
    })
    expect(() =>
      store.beginPartition({
        partitionKey: "spy-daily",
        kind: "UNDERLYING_DAILY_BARS",
        request: { endpoint: "/bars", parameters: { timeframe: "1Min" } },
        updatedAt: "2026-08-27T10:00:00.000Z",
      }),
    ).toThrow("definition changed")
    store.appendPage({
      partitionKey: "spy-daily",
      records: [],
      nextPageToken: "next",
      updatedAt: "2026-08-27T10:00:00.000Z",
    })
    expect(() =>
      store.appendPage({
        partitionKey: "spy-daily",
        expectedPageToken: "wrong",
        records: [],
        updatedAt: "2026-08-27T10:00:00.000Z",
      }),
    ).toThrow("page token changed")
    store.close()
  })

  it("creates, reopens, and context-validates V2 datasets in the unchanged SQLite schema", () => {
    const path = createPath()
    const definitionV2 = createBacktestDatasetDefinitionV2Fixture({
      optionSymbols: [],
    })
    const store = createBacktestDatasetStore({
      path,
      definition: definitionV2,
    })
    store.beginPartition({
      partitionKey: "underlying-daily",
      kind: "UNDERLYING_DAILY_BARS",
      request: {
        endpoint: "/v2/stocks/bars",
        parameters: { symbols: "SPY" },
      },
      updatedAt: "2024-06-05T10:00:00.000Z",
    })
    expect(() =>
      store.appendPage({
        partitionKey: "underlying-daily",
        records: [{
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
        }],
        updatedAt: "2024-06-05T10:00:01.000Z",
      })
    ).toThrow("does not match")
    store.close()

    const reopened = createBacktestDatasetStore({ path, readonly: true })
    expect(reopened.definition).toEqual(definitionV2)
    reopened.close()
  })

  it("produces the same V2 partition checksum regardless of provider row order", () => {
    const create = (records: readonly {
      recordType: "MARKET_SESSION"
      date: string
      open: string
      close: string
    }[]) => {
      const store = createBacktestDatasetStore({
        path: createPath(),
        definition: createBacktestDatasetDefinitionV2Fixture({
          optionSymbols: [],
        }),
      })
      store.beginPartition({
        partitionKey: "calendar",
        kind: "MARKET_CALENDAR",
        request: { endpoint: "/v2/calendar", parameters: {} },
        updatedAt: "2024-06-05T10:00:00.000Z",
      })
      store.appendPage({
        partitionKey: "calendar",
        records,
        updatedAt: "2024-06-05T10:00:01.000Z",
      })
      const checksum = store.completePartition(
        "calendar",
        "2024-06-05T10:00:02.000Z",
      ).checksum
      store.close()
      return checksum
    }
    const records = [
      {
        recordType: "MARKET_SESSION" as const,
        date: "2024-06-03",
        open: "2024-06-03T13:30:00.000Z",
        close: "2024-06-03T20:00:00.000Z",
      },
      {
        recordType: "MARKET_SESSION" as const,
        date: "2024-06-04",
        open: "2024-06-04T13:30:00.000Z",
        close: "2024-06-04T20:00:00.000Z",
      },
    ]
    expect(create(records)).toBe(create([...records].reverse()))
  })

  it("opens a completed dataset read-only and rejects mismatched identity", () => {
    const path = createPath()
    const store = createBacktestDatasetStore({ path, definition })
    store.close()
    const readonly = createBacktestDatasetStore({ path, readonly: true })
    expect(readonly.definition).toEqual(definition)
    expect(() =>
      readonly.beginPartition({
        partitionKey: "calendar",
        kind: "MARKET_CALENDAR",
        request: { endpoint: "/calendar", parameters: {} },
        updatedAt: "2026-08-27T10:00:00.000Z",
      }),
    ).toThrow("read-only")
    readonly.close()

    expect(() =>
      createBacktestDatasetStore({
        path,
        definition: { ...definition, datasetId: "different" },
      }),
    ).toThrow("does not match")
  })
})
