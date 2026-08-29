import { describe, expect, it, vi } from "vitest"

import { createAlpacaHistoricalClient } from "../src/market-data/alpaca-historical-client.js"

const jsonResponse = (
  body: unknown,
  status = 200,
  headers?: HeadersInit,
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

const createClient = (fetchImplementation: typeof fetch) =>
  createAlpacaHistoricalClient({
    apiKey: "key",
    secretKey: "secret",
    fetch: fetchImplementation,
    dataBaseUrl: "https://data.test.invalid/path",
    tradingBaseUrl: "https://paper.test.invalid/path",
    now: () => new Date("2026-08-27T10:00:00.000Z"),
    sleep: vi.fn().mockResolvedValue(undefined),
  })

describe("Alpaca historical client", () => {
  it.each([
    "http://data.alpaca.markets",
    "https://user:password@data.alpaca.markets",
    "https://example.com",
  ])("rejects unsafe production data URL %s", (dataBaseUrl) => {
    expect(() =>
      createAlpacaHistoricalClient({
        apiKey: "key",
        secretKey: "secret",
        dataBaseUrl,
      }),
    ).toThrow("credential-free Alpaca HTTPS URL")
  })

  it("normalizes Alpaca calendar local times across daylight saving time", async () => {
    const client = createClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse([
          { date: "2024-02-01", open: "09:30", close: "16:00" },
          { date: "2024-06-03", open: "09:30", close: "16:00" },
        ]),
      ),
    )

    await expect(
      client.getCalendar({
        fromDate: "2024-02-01",
        toDate: "2024-06-03",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual([
      {
        recordType: "MARKET_SESSION",
        date: "2024-02-01",
        open: "2024-02-01T14:30:00.000Z",
        close: "2024-02-01T21:00:00.000Z",
      },
      {
        recordType: "MARKET_SESSION",
        date: "2024-06-03",
        open: "2024-06-03T13:30:00.000Z",
        close: "2024-06-03T20:00:00.000Z",
      },
    ])
  })

  it("normalizes and paginates SPY bars without exposing credentials in the URL", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        bars: {
          SPY: [
            {
              t: "2024-02-01T14:30:00Z",
              o: 490.1,
              h: 491.2,
              l: 489.9,
              c: 491,
              v: 1234,
              vw: 490.75,
            },
          ],
        },
        next_page_token: "next",
      }),
    )
    const page = await createClient(fetchMock).getUnderlyingBarsPage({
      timeframe: "1MINUTE",
      fromDate: "2024-02-01",
      toDate: "2024-02-02",
      signal: new AbortController().signal,
    })

    expect(page).toEqual({
      records: [
        {
          recordType: "UNDERLYING_BAR",
          symbol: "SPY",
          timeframe: "1MINUTE",
          timestamp: "2024-02-01T14:30:00.000Z",
          openMicros: 490_100_000,
          highMicros: 491_200_000,
          lowMicros: 489_900_000,
          closeMicros: 491_000_000,
          volume: 1234,
          vwapMicros: 490_750_000,
        },
      ],
      nextPageToken: "next",
    })
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]!
    const url = new URL(String(requestUrl))
    expect(url.pathname).toBe("/v2/stocks/bars")
    expect(url.searchParams.get("feed")).toBe("iex")
    expect(url.searchParams.get("adjustment")).toBe("all")
    expect(url.searchParams.get("end")).toBe("2024-02-02T23:59:59.999Z")
    expect(url.toString()).not.toContain("key")
    expect(requestInit).toMatchObject({
      method: "GET",
      headers: {
        "APCA-API-KEY-ID": "key",
        "APCA-API-SECRET-KEY": "secret",
      },
    })
  })

  it("normalizes current contract metadata with explicitly dated open interest", async () => {
    const client = createClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          option_contracts: [
            {
              symbol: "SPY240216C00500000",
              expiration_date: "2024-02-16",
              type: "call",
              strike_price: "500",
              status: "inactive",
              tradable: false,
              style: "american",
              size: "100",
              open_interest: "700",
              open_interest_date: "2024-02-15",
            },
          ],
        }),
      ),
    )
    await expect(
      client.getOptionContractsPage({
        fromDate: "2024-02-16",
        toDate: "2024-02-16",
        status: "inactive",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      records: [
        {
          recordType: "OPTION_CONTRACT",
          contractSymbol: "SPY240216C00500000",
          strikeCentsPerShare: 50_000,
          openInterest: 700,
          openInterestDate: "2024-02-15",
          retrievedAt: "2026-08-27T10:00:00.000Z",
        },
      ],
    })
  })

  it("normalizes the scalar condition returned by historical option trades", async () => {
    const client = createClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          trades: {
            SPY240216C00500000: [
              {
                t: "2024-02-01T15:00:00Z",
                p: 2.5,
                s: 3,
                c: "S",
                i: "trade-1",
                x: "C",
              },
            ],
          },
        }),
      ),
    )

    await expect(
      client.getOptionTradesPage({
        contractSymbols: ["SPY240216C00500000"],
        fromDate: "2024-02-01",
        toDate: "2024-02-01",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      records: [
        {
          recordType: "OPTION_TRADE",
          conditions: ["S"],
          priceMicros: 2_500_000,
        },
      ],
    })
  })

  it.each([
    ["empty", []],
    ["over-limit", Array(101).fill("SPY240216C00500000")],
    ["malformed", ["not-a-symbol"]],
    ["unsupported", ["QQQ240216C00500000"]],
    ["impossible-date", ["SPY240231C00500000"]],
  ])(
    "rejects a %s option-symbol request before provider I/O",
    async (_case, contractSymbols) => {
      const fetchMock = vi.fn<typeof fetch>()
      const client = createClient(fetchMock)

      await expect(
        client.getOptionBarsPage({
          contractSymbols,
          timeframe: "1MINUTE",
          fromDate: "2024-02-01",
          toDate: "2024-02-01",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("Alpaca option symbols are invalid")
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it("deduplicates and sorts exact option symbols in historical requests", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ bars: {} }))
    const client = createClient(fetchMock)

    await client.getOptionBarsPage({
      contractSymbols: [
        "SPY240216C00505000",
        "SPY240216C00500000",
        "SPY240216C00505000",
      ],
      timeframe: "1MINUTE",
      fromDate: "2024-02-01",
      toDate: "2024-02-01",
      signal: new AbortController().signal,
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const url = new URL(String(fetchMock.mock.calls[0]![0]))
    expect(url.searchParams.get("symbols")).toBe(
      "SPY240216C00500000,SPY240216C00505000",
    )
  })

  it("retries a rate limit using bounded Retry-After handling", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 429, { "retry-after": "1" }))
      .mockResolvedValueOnce(jsonResponse({ bars: {} }))
    const sleep = vi.fn().mockResolvedValue(undefined)
    const client = createAlpacaHistoricalClient({
      apiKey: "key",
      secretKey: "secret",
      fetch: fetchMock,
      dataBaseUrl: "https://data.test.invalid",
      tradingBaseUrl: "https://paper.test.invalid",
      sleep,
    })
    await client.getUnderlyingBarsPage({
      timeframe: "1DAY",
      fromDate: "2024-02-01",
      toDate: "2024-02-02",
      signal: new AbortController().signal,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(1_000, expect.any(AbortSignal))
  })

  it.each([undefined, "", "invalid", "-1"])(
    "backs off when Retry-After is absent or invalid: %s",
    async (retryAfter) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(
          {},
          429,
          retryAfter === undefined ? undefined : { "retry-after": retryAfter },
        ))
        .mockResolvedValueOnce(jsonResponse({ bars: {} }))
      const sleep = vi.fn().mockResolvedValue(undefined)
      const client = createAlpacaHistoricalClient({
        apiKey: "key",
        secretKey: "secret",
        fetch: fetchMock,
        dataBaseUrl: "https://data.test.invalid",
        tradingBaseUrl: "https://paper.test.invalid",
        sleep,
      })

      await client.getUnderlyingBarsPage({
        timeframe: "1DAY",
        fromDate: "2024-02-01",
        toDate: "2024-02-02",
        signal: new AbortController().signal,
      })

      expect(sleep).toHaveBeenCalledWith(250, expect.any(AbortSignal))
    },
  )
})
