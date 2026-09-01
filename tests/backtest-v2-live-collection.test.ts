import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import Database from "better-sqlite3"
import { describe, expect, it, vi } from "vitest"

import { createAlpacaForwardCollectionProvider, parseHalfCents } from "../src/backtest-v2/live-collection/alpaca-provider-v1.js"
import { createCollectionStoreV1 } from "../src/backtest-v2/live-collection/collection-store-v1.js"
import { forwardCollectionConfigV1Schema } from "../src/backtest-v2/live-collection/contracts-v1.js"
import { runForwardCollectorV1 } from "../src/backtest-v2/live-collection/collector-v1.js"

const response = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
})

const config = (databasePath: string) => forwardCollectionConfigV1Schema.parse({
  configVersion: "1.0.0",
  databasePath,
  symbols: ["SPY"],
  feed: "indicative",
  stockFeed: "iex",
  minDte: 7,
  maxDte: 45,
  minMoneyness: 0.8,
  maxMoneyness: 1.2,
  pollSeconds: 60,
  contractRefreshMinutes: 15,
  snapshotBatchSize: 100,
  requestTimeoutMilliseconds: 30_000,
  freshQuoteMilliseconds: 60_000,
  researchArtifactRoot: join(tmpdir(), "missing-research-artifacts"),
})

describe("Backtest V2 forward option collection", () => {
  it("parses only exactly representable half-cent prices", () => {
    expect(parseHalfCents("2.505")).toBe(501)
    expect(parseHalfCents("2.50")).toBe(500)
    expect(parseHalfCents("2.501")).toBeUndefined()
    expect(parseHalfCents("0")).toBeUndefined()
  })

  it("bootstraps contracts and labels an after-hours quote as outside-session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forward-option-collection-"))
    const databasePath = join(directory, "capture.sqlite")
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/stocks/snapshots") {
        return response({
          snapshots: {
            SPY: { latestTrade: { p: "500.00", t: "2026-09-01T20:00:00Z" } },
          },
        })
      }
      if (url.pathname === "/v2/options/contracts") {
        return response({
          option_contracts: [{
            id: "contract-spy-500-call",
            symbol: "SPY260918C00500000",
            underlying_symbol: "SPY",
            expiration_date: "2026-09-18",
            type: "call",
            style: "american",
            strike_price: "500",
            size: "100",
            status: "active",
            tradable: true,
            open_interest: "1000",
            open_interest_date: "2026-09-01",
          }],
          next_page_token: null,
        })
      }
      if (url.pathname === "/v1beta1/options/snapshots") {
        return response({
          snapshots: {
            SPY260918C00500000: {
              latestQuote: {
                bp: "4.95",
                ap: "5.00",
                bs: 10,
                as: 12,
                bx: "C",
                ax: "P",
                c: ["R"],
                t: "2026-09-01T19:59:59Z",
              },
            },
          },
        })
      }
      throw new Error(`Unexpected URL ${url.pathname}`)
    })
    const provider = createAlpacaForwardCollectionProvider({
      apiKey: "test-key",
      secretKey: "test-secret",
      dataBaseUrl: "https://data.test.invalid",
      tradingBaseUrl: "https://trading.test.invalid",
      fetch: fetchMock,
    })
    const store = createCollectionStoreV1(databasePath)
    try {
      const report = await runForwardCollectorV1({
        mode: "ONCE",
        sessionDate: "2026-09-01",
        config: config(databasePath),
        signal: new AbortController().signal,
      }, {
        provider,
        calendar: {
          getSession: async () => ({
            date: "2026-09-01",
            open: "2026-09-01T13:30:00.000Z",
            close: "2026-09-01T20:00:00.000Z",
            previousSessionDates: [],
          }),
        },
        store,
        now: () => new Date("2026-09-01T22:00:00.000Z"),
      })
      expect(report.retainedContracts).toBe(1)
      expect(report.polls).toBe(1)
    } finally {
      store.close()
    }

    const database = new Database(databasePath, { readonly: true })
    try {
      expect(database.prepare(`
        SELECT session_state, fresh_count, stale_count, invalid_count
        FROM quote_poll_attempts
      `).get()).toEqual({
        session_state: "AFTER_HOURS",
        fresh_count: 0,
        stale_count: 1,
        invalid_count: 0,
      })
      expect(database.prepare(`
        SELECT quality, bid_half_cents, ask_half_cents, quote_age_milliseconds
        FROM option_quote_observations
      `).get()).toEqual({
        quality: "OUTSIDE_SESSION",
        bid_half_cents: 990,
        ask_half_cents: 1000,
        quote_age_milliseconds: 7_201_000,
      })
    } finally {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("imports research artifacts idempotently into the capture lineage", () => {
    const directory = mkdtempSync(join(tmpdir(), "forward-research-capture-"))
    const databasePath = join(directory, "capture.sqlite")
    const store = createCollectionStoreV1(databasePath)
    try {
      const artifact = {
        runVersion: "7.0.0",
        cycle: {
          cycleId: "cycle-1",
          cycleNumber: 1,
          sessionDate: "2026-09-01",
          startedAt: "2026-09-01T14:00:00.000Z",
          completedAt: "2026-09-01T14:01:00.000Z",
        },
        outcome: { status: "VALIDATED_NO_ACTION" },
      }
      expect(store.importResearchArtifact(
        "workspace/research/2026-09-01/cycle-1.json",
        artifact,
        "2026-09-01T14:01:01.000Z",
      )).toBe(true)
      expect(store.importResearchArtifact(
        "workspace/research/2026-09-01/cycle-1.json",
        artifact,
        "2026-09-01T14:01:02.000Z",
      )).toBe(false)
    } finally {
      store.close()
    }
    const database = new Database(databasePath, { readonly: true })
    try {
      expect(database.prepare(`
        SELECT run_version, cycle_id, outcome_status FROM research_artifacts
      `).get()).toEqual({
        run_version: "7.0.0",
        cycle_id: "cycle-1",
        outcome_status: "VALIDATED_NO_ACTION",
      })
    } finally {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
