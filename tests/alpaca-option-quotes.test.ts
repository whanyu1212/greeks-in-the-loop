import { describe, expect, it, vi } from "vitest"

import {
  createAlpacaOptionQuoteProvider,
  type OptionQuoteConfirmationFailureCode,
} from "../src/market-data/alpaca-option-quotes.js"

const longSymbol = "SPY260918C00650000"
const shortSymbol = "SPY260918C00655000"
const evaluatedAt = new Date("2026-08-25T14:31:00.000Z")

const quoteResponse = (
  longQuote: Record<string, unknown> = {
    bp: 2.2,
    ap: 2.23,
    t: "2026-08-25T14:30:30.123456789Z",
  },
  shortQuote: Record<string, unknown> = {
    bp: 1.2,
    ap: 1.21,
    t: "2026-08-25T14:30:31.987654321Z",
  },
) => ({
  snapshots: {
    [shortSymbol]: { latestQuote: shortQuote },
    [longSymbol]: { latestQuote: longQuote },
  },
})

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const createProvider = (
  fetchImplementation: typeof fetch,
  now = () => evaluatedAt,
) =>
  createAlpacaOptionQuoteProvider({
    apiKey: "test-key",
    secretKey: "test-secret",
    fetch: fetchImplementation,
    now,
  })

const expectFailure = async (
  body: unknown,
  expected: OptionQuoteConfirmationFailureCode,
  now = () => evaluatedAt,
) => {
  const provider = createProvider(
    vi.fn<typeof fetch>().mockResolvedValue(response(body)),
    now,
  )
  const result = await provider.confirmQuotes({
    contractSymbols: [longSymbol, shortSymbol],
    signal: new AbortController().signal,
  })

  expect(result).toEqual({ success: false, reasons: [expected] })
}

describe("Alpaca option quote provider", () => {
  it("exposes only the read-only quote confirmation operation", () => {
    const provider = createProvider(vi.fn<typeof fetch>())

    expect(Object.keys(provider)).toEqual(["confirmQuotes"])
  })

  it.each([
    "not-a-url",
    "http://data.alpaca.markets",
    "https://user:password@data.alpaca.markets",
    "https://data.alpaca.markets:8443",
    "https://example.com",
  ])("rejects unsafe production base URL %s without echoing it", (baseUrl) => {
    expect(() =>
      createAlpacaOptionQuoteProvider({
        apiKey: "test-key",
        secretKey: "test-secret",
        baseUrl,
      }),
    ).toThrow(
      "ALPACA_MARKET_DATA_BASE_URL must be a credential-free Alpaca HTTPS URL",
    )
  })

  it("allows an injected transport to use a credential-free HTTPS test origin", () => {
    expect(() =>
      createAlpacaOptionQuoteProvider({
        apiKey: "test-key",
        secretKey: "test-secret",
        baseUrl: "https://test.invalid/path?ignored=true",
        fetch: vi.fn<typeof fetch>(),
      }),
    ).not.toThrow()
  })

  it("fetches both exact symbols in one read-only indicative request", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(quoteResponse()))
    const provider = createProvider(fetchMock)

    const result = await provider.confirmQuotes({
      contractSymbols: [longSymbol, shortSymbol],
      signal: new AbortController().signal,
    })

    expect(result).toEqual({
      success: true,
      snapshot: {
        snapshotVersion: "2.0.0",
        evaluatedAt: "2026-08-25T14:31:00.000Z",
        snapshotMetadata: {
          provider: "ALPACA",
          source: "options-snapshots-indicative",
          retrievedAt: "2026-08-25T14:31:00.000Z",
          freshUntil: "2026-08-25T14:31:30.123Z",
        },
        quotes: [
          {
            contractSymbol: longSymbol,
            feed: "INDICATIVE",
            bidCentsPerShare: 220,
            askCentsPerShare: 223,
            providerTimestamp: "2026-08-25T14:30:30.123456789Z",
          },
          {
            contractSymbol: shortSymbol,
            feed: "INDICATIVE",
            bidCentsPerShare: 120,
            askCentsPerShare: 121,
            providerTimestamp: "2026-08-25T14:30:31.987654321Z",
          },
        ],
      },
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]!
    const url = new URL(String(requestUrl))
    expect(url.origin).toBe("https://data.alpaca.markets")
    expect(url.pathname).toBe("/v1beta1/options/snapshots")
    expect(url.searchParams.get("symbols")).toBe(
      `${longSymbol},${shortSymbol}`,
    )
    expect(url.searchParams.get("feed")).toBe("indicative")
    expect(requestInit).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: {
        "APCA-API-KEY-ID": "test-key",
        "APCA-API-SECRET-KEY": "test-secret",
      },
    })
    expect(requestInit).not.toHaveProperty("body")
  })

  it("captures one through four quotes in requested order", async () => {
    const symbols = [
      "SPY260918P00640000",
      longSymbol,
      shortSymbol,
      "SPY260918C00660000",
    ]
    const snapshots = Object.fromEntries([...symbols].reverse().map(
      (symbol, index) => [symbol, {
        latestQuote: {
          bp: (1 + index / 10).toFixed(2),
          ap: (1.05 + index / 10).toFixed(2),
          t: `2026-08-25T14:30:3${index}.000Z`,
        },
      }],
    ))
    const provider = createProvider(
      vi.fn<typeof fetch>().mockResolvedValue(response({ snapshots })),
    )

    const result = await provider.confirmQuotes({
      contractSymbols: symbols,
      signal: new AbortController().signal,
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error("Expected quote confirmation")
    expect(result.snapshot.quotes.map(({ contractSymbol }) => contractSymbol))
      .toEqual(symbols)
  })

  it("rejects empty, duplicate, and over-limit quote requests before I/O", async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const provider = createProvider(fetchMock)
    for (const contractSymbols of [
      [],
      [longSymbol, longSymbol],
      [longSymbol, shortSymbol, "SPY260918C00660000", "SPY260918C00665000", "SPY260918C00670000"],
    ]) {
      await expect(provider.confirmQuotes({
        contractSymbols,
        signal: new AbortController().signal,
      })).resolves.toEqual({
        success: false,
        reasons: ["QUOTE_SYMBOL_MISSING"],
      })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ["malformed", "not-a-symbol"],
    ["mixed-underlying", "QQQ260918C00650000"],
    ["unsupported", "DIA260918C00650000"],
    ["impossible-date", "SPY260431C00650000"],
  ])(
    "rejects a %s requested symbol before provider I/O",
    async (_case, invalidSymbol) => {
      const fetchMock = vi.fn<typeof fetch>()
      const provider = createProvider(fetchMock)

      await expect(
        provider.confirmQuotes({
          contractSymbols: [invalidSymbol, shortSymbol],
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({
        success: false,
        reasons: ["QUOTE_SYMBOL_MISSING"],
      })
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it("accepts two exact QQQ legs", async () => {
    const qqqLong = "QQQ260918C00650000"
    const qqqShort = "QQQ260918C00655000"
    const provider = createProvider(
      vi.fn<typeof fetch>().mockResolvedValue(response({
        snapshots: {
          [qqqLong]: { latestQuote: { bp: 2.2, ap: 2.23, t: "2026-08-25T14:30:30.000Z" } },
          [qqqShort]: { latestQuote: { bp: 1.2, ap: 1.21, t: "2026-08-25T14:30:31.000Z" } },
        },
      })),
    )

    await expect(provider.confirmQuotes({
      contractSymbols: [qqqLong, qqqShort],
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ success: true })
  })

  it("matches quotes by symbol rather than response order", async () => {
    const provider = createProvider(
      vi.fn<typeof fetch>().mockResolvedValue(response(quoteResponse())),
    )

    const result = await provider.confirmQuotes({
      contractSymbols: [longSymbol, shortSymbol],
      signal: new AbortController().signal,
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error("Expected quote confirmation")
    expect(result.snapshot.quotes.map(({ contractSymbol }) => contractSymbol)).toEqual([
      longSymbol,
      shortSymbol,
    ])
  })

  it("accepts a quote fresh at the exact 60-second boundary", async () => {
    await expectFailure(
      quoteResponse(
        { bp: 2.2, ap: 2.23, t: "2026-08-25T14:30:00.000000000Z" },
        { bp: 1.2, ap: 1.21, t: "2026-08-25T14:30:00.000000000Z" },
      ),
      "QUOTE_STALE",
      () => new Date("2026-08-25T14:31:00.001Z"),
    )

    const provider = createProvider(
      vi.fn<typeof fetch>().mockResolvedValue(
        response(
          quoteResponse(
            { bp: 2.2, ap: 2.23, t: "2026-08-25T14:30:00.000000000Z" },
            { bp: 1.2, ap: 1.21, t: "2026-08-25T14:30:00.000000000Z" },
          ),
        ),
      ),
    )
    const result = await provider.confirmQuotes({
      contractSymbols: [longSymbol, shortSymbol],
      signal: new AbortController().signal,
    })
    expect(result.success).toBe(true)
  })

  it("preserves sub-millisecond future ordering", async () => {
    await expectFailure(
      quoteResponse({
        bp: 2.2,
        ap: 2.23,
        t: "2026-08-25T14:31:00.0009Z",
      }),
      "QUOTE_FROM_FUTURE",
    )
  })

  it.each([
    [{ bp: 0, ap: 2.23, t: "2026-08-25T14:30:30.000Z" }],
    [{ bp: 2.2, ap: 2.2, t: "2026-08-25T14:30:30.000Z" }],
    [{ bp: 2.2, ap: 2.199, t: "2026-08-25T14:30:30.000Z" }],
    [{ bp: "not-money", ap: 2.23, t: "2026-08-25T14:30:30.000Z" }],
  ])("rejects invalid price payload %j", async (invalidQuote) => {
    await expectFailure(
      quoteResponse(invalidQuote),
      "QUOTE_PRICE_INVALID",
    )
  })

  it("rejects a missing proposed symbol", async () => {
    await expectFailure(
      {
        snapshots: {
          [longSymbol]: {
            latestQuote: {
              bp: 2.2,
              ap: 2.23,
              t: "2026-08-25T14:30:30.000Z",
            },
          },
        },
      },
      "QUOTE_SYMBOL_MISSING",
    )
  })

  it("rejects invalid provider timestamps", async () => {
    await expectFailure(
      quoteResponse({ bp: 2.2, ap: 2.23, t: "not-a-time" }),
      "QUOTE_TIMESTAMP_INVALID",
    )
  })

  it("returns bounded failures for non-2xx and malformed responses", async () => {
    const nonSuccessProvider = createProvider(
      vi.fn<typeof fetch>().mockResolvedValue(response({}, 503)),
    )
    const malformedProvider = createProvider(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("{", { status: 200 })),
    )

    await expect(
      nonSuccessProvider.confirmQuotes({
        contractSymbols: [longSymbol, shortSymbol],
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      success: false,
      reasons: ["QUOTE_REQUEST_FAILED"],
    })
    await expect(
      malformedProvider.confirmQuotes({
        contractSymbols: [longSymbol, shortSymbol],
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      success: false,
      reasons: ["QUOTE_RESPONSE_INVALID"],
    })
  })

  it("propagates cancellation instead of recording a quote failure", async () => {
    const abortReason = new DOMException("Aborted", "AbortError")
    const provider = createProvider(
      vi.fn<typeof fetch>().mockRejectedValue(abortReason),
    )

    await expect(
      provider.confirmQuotes({
        contractSymbols: [longSymbol, shortSymbol],
        signal: AbortSignal.abort(abortReason),
      }),
    ).rejects.toBe(abortReason)
  })

  it("propagates cancellation during response-body parsing", async () => {
    const abortReason = new DOMException("Timed out", "TimeoutError")
    const controller = new AbortController()
    const bodyResponse = response(quoteResponse())
    bodyResponse.json = vi.fn(async () => {
      controller.abort(abortReason)
      throw abortReason
    })
    const provider = createProvider(
      vi.fn<typeof fetch>().mockResolvedValue(bodyResponse),
    )

    await expect(
      provider.confirmQuotes({
        contractSymbols: [longSymbol, shortSymbol],
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason)
  })

  it("never includes credentials or provider bodies in a failure", async () => {
    const secretMarker = "must-not-leak"
    const provider = createAlpacaOptionQuoteProvider({
      apiKey: secretMarker,
      secretKey: secretMarker,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(secretMarker, { status: 500 }),
      ),
      now: () => evaluatedAt,
    })

    const result = await provider.confirmQuotes({
      contractSymbols: [longSymbol, shortSymbol],
      signal: new AbortController().signal,
    })

    expect(JSON.stringify(result)).not.toContain(secretMarker)
  })
})
