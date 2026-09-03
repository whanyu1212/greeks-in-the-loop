import { describe, expect, it, vi } from "vitest"

import { createAlpacaOptionUniverseProvider } from "../src/market-data/alpaca-option-universe.js"
import { canonicalJsonSha256 } from "../src/shared/canonical-json.js"

const response = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
})

const contract = (
  underlying: string,
  strike: number,
  type: "call" | "put" = "call",
  openInterest = 1_000,
) => ({
  underlying_symbol: underlying,
  expiration_date: "2026-09-18",
  status: "active",
  tradable: true,
  type,
  style: "american",
  strike_price: String(strike),
  size: "100",
  open_interest: String(openInterest),
})

describe("Alpaca option universe provider", () => {
  it("selects three active underlyings by executable option liquidity", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/assets") {
        return response([
          ...["AAPL", "TSLA", "NVDA", "AMD"].map((symbol) => ({
            symbol,
            status: "active",
            tradable: true,
            attributes: ["has_options"],
          })),
          {
            symbol: "BRK.B",
            status: "active",
            tradable: true,
            attributes: ["has_options"],
          },
        ])
      }
      if (url.pathname === "/v1beta1/screener/stocks/most-actives") {
        return response({
          most_actives: ["AAPL", "BRK.B", "TSLA", "NVDA", "AMD"]
            .map((symbol) => ({ symbol })),
        })
      }
      if (url.pathname === "/v1beta1/screener/stocks/movers") {
        return response({
          gainers: [
            { symbol: "TSLA", percent_change: "5.2" },
            { symbol: "AMD", percent_change: 3.1 },
          ],
          losers: [{ symbol: "NVDA", percent_change: "-4.4" }],
        })
      }
      if (url.pathname === "/v2/options/contracts") {
        return response({
          option_contracts: [
            contract("TSLA", 300, "call", 1_200),
            contract("TSLA", 305, "call", 1_100),
            contract("NVDA", 180),
            contract("AMD", 220, "put", 900),
            contract("AMD", 215, "put", 800),
            contract("AAPL", 250, "call", 600),
            contract("AAPL", 255, "call", 600),
          ],
        })
      }
      throw new Error(`Unexpected test URL: ${url.pathname}`)
    })
    const provider = createAlpacaOptionUniverseProvider({
      apiKey: "test-key",
      secretKey: "test-secret",
      dataBaseUrl: "https://data.test.invalid",
      tradingBaseUrl: "https://trading.test.invalid",
      fetch: fetchMock,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
    })

    const snapshot = await provider.discover(
      "2026-08-25",
      new AbortController().signal,
    )

    expect(snapshot.candidates.map(({ underlying }) => underlying)).toEqual([
      "AAPL",
      "TSLA",
      "AMD",
    ])
    expect(snapshot.candidates[0]).toMatchObject({
      rank: 1,
      underlying: "AAPL",
      activityRank: 1,
      optionLiquidity: {
        expirationCount: 1,
        viableSeriesCount: 1,
        liquidSeriesCount: 1,
        contractCount: 2,
        liquidContractCount: 2,
        totalOpenInterest: 1_200,
        openInterestCoverage: 1,
      },
    })
    const { snapshotId, ...content } = snapshot
    expect(snapshotId).toBe(
      `option-universe-v2-${canonicalJsonSha256(content)}`,
    )

    const calls = fetchMock.mock.calls.map(([input, init]) => ({
      url: new URL(String(input)),
      init,
    }))
    expect(calls.map(({ url }) => url.pathname).sort()).toEqual([
      "/v1beta1/screener/stocks/most-actives",
      "/v1beta1/screener/stocks/movers",
      "/v2/assets",
      "/v2/options/contracts",
    ])
    expect(calls.find(({ url }) => url.pathname === "/v2/assets")!
      .url.searchParams.get("attributes")).toBe("has_options")
    const contractsUrl = calls.find(
      ({ url }) => url.pathname === "/v2/options/contracts",
    )!.url
    expect(contractsUrl.searchParams.get("underlying_symbols")).toBe(
      "AAPL,TSLA,NVDA,AMD",
    )
    expect(contractsUrl.searchParams.get("expiration_date_gte")).toBe(
      "2026-09-08",
    )
    expect(contractsUrl.searchParams.get("expiration_date_lte")).toBe(
      "2026-09-24",
    )
    expect(calls.every(({ init }) =>
      init?.method === "GET" && init.body === undefined
    )).toBe(true)
  })

  it("excludes series whose strikes do not both meet the discovery OI floor", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/assets") {
        return response(["AAPL", "TSLA", "AMD", "NVDA"].map((symbol) => ({
          symbol,
          status: "active",
          tradable: true,
          attributes: ["has_options"],
        })))
      }
      if (url.pathname === "/v1beta1/screener/stocks/most-actives") {
        return response({
          most_actives: ["NVDA", "AAPL", "TSLA", "AMD"].map((symbol) => ({ symbol })),
        })
      }
      if (url.pathname === "/v1beta1/screener/stocks/movers") {
        return response({ gainers: [], losers: [] })
      }
      if (url.pathname === "/v2/options/contracts") {
        return response({
          option_contracts: [
            contract("NVDA", 180, "call", 2_000),
            contract("NVDA", 185, "call", 499),
            ...["AAPL", "TSLA", "AMD"].flatMap((symbol, index) => [
              contract(symbol, 100 + index * 10, "call", 1_000),
              contract(symbol, 105 + index * 10, "call", 900),
            ]),
          ],
        })
      }
      throw new Error(`Unexpected test URL: ${url.pathname}`)
    })
    const provider = createAlpacaOptionUniverseProvider({
      apiKey: "test-key",
      secretKey: "test-secret",
      dataBaseUrl: "https://data.test.invalid",
      tradingBaseUrl: "https://trading.test.invalid",
      fetch: fetchMock,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
    })

    const snapshot = await provider.discover(
      "2026-08-25",
      new AbortController().signal,
    )

    expect(snapshot.candidates.map(({ underlying }) => underlying))
      .toEqual(["AAPL", "TSLA", "AMD"])
  })

  it("reserves discovery capacity for active names, gainers, and losers", async () => {
    const actives = Array.from({ length: 100 }, (_, index) =>
      `A${String(index).padStart(2, "0")}`
    )
    const gainers = Array.from({ length: 50 }, (_, index) =>
      `G${String(index).padStart(2, "0")}`
    )
    const losers = Array.from({ length: 50 }, (_, index) =>
      `L${String(index).padStart(2, "0")}`
    )
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/assets") {
        return response([...actives, ...gainers, ...losers].map((symbol) => ({
          symbol,
          status: "active",
          tradable: true,
          attributes: ["has_options"],
        })))
      }
      if (url.pathname === "/v1beta1/screener/stocks/most-actives") {
        return response({ most_actives: actives.map((symbol) => ({ symbol })) })
      }
      if (url.pathname === "/v1beta1/screener/stocks/movers") {
        return response({
          gainers: gainers.map((symbol, index) => ({
            symbol,
            percent_change: 50 - index,
          })),
          losers: losers.map((symbol, index) => ({
            symbol,
            percent_change: index - 50,
          })),
        })
      }
      if (url.pathname === "/v2/options/contracts") {
        return response({
          option_contracts: [
            contract("A00", 100),
            contract("A00", 105),
            contract("G00", 100),
            contract("G00", 105),
            contract("L00", 100),
            contract("L00", 105),
          ],
        })
      }
      throw new Error(`Unexpected test URL: ${url.pathname}`)
    })
    const provider = createAlpacaOptionUniverseProvider({
      apiKey: "test-key",
      secretKey: "test-secret",
      dataBaseUrl: "https://data.test.invalid",
      tradingBaseUrl: "https://trading.test.invalid",
      fetch: fetchMock,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
    })

    await provider.discover("2026-08-25", new AbortController().signal)

    // The pool is queried in chunks, so the screen is the union of the
    // contract calls rather than a single request.
    const contractsCalls = fetchMock.mock.calls.filter(([input]) =>
      new URL(String(input)).pathname === "/v2/options/contracts"
    )
    const screened = contractsCalls.flatMap(([input]) =>
      new URL(String(input)).searchParams.get("underlying_symbols")?.split(",") ??
        []
    )
    expect(screened).toHaveLength(100)
    expect(new Set(screened).size).toBe(100)
    expect(screened.filter((symbol) => symbol.startsWith("A"))).toHaveLength(50)
    expect(screened.filter((symbol) => symbol.startsWith("G"))).toHaveLength(25)
    expect(screened.filter((symbol) => symbol.startsWith("L"))).toHaveLength(25)
  })
})
