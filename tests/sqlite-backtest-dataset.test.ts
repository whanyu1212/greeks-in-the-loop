import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { BacktestDatasetDefinitionV1 } from "../src/backtest/dataset-v1.js"
import { createBacktestDatasetStore } from "../src/backtest/sqlite-dataset-store.js"

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
