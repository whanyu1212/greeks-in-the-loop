import { describe, expect, it, vi } from "vitest"

import {
  createAlpacaResearchSnapshotProvider,
  type CreateAlpacaResearchSnapshotProviderOptions,
} from "../src/market-data/alpaca-research-snapshot-provider-v1.js"
import { validateResearchSnapshotPairV1 } from "../src/contracts/research-market-snapshot-builders-v1.js"
import {
  CALL_CONTRACT_SYMBOL,
  CAPTURE_SESSION_DATE,
  CAPTURE_SLOT_STARTED_AT,
  PUT_CONTRACT_SYMBOL,
  createSuccessfulAlpacaResearchResponses,
} from "./fixtures/alpaca-research-snapshot-provider-v1.js"

const jsonResponse = (
  body: unknown,
  status = 200,
  headers?: HeadersInit,
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

const createNow = () => {
  let milliseconds = Date.parse("2026-08-28T14:00:02.000Z")
  return () => {
    const value = new Date(milliseconds)
    milliseconds += 1_000
    return value
  }
}

const createFixtureFetch = (
  responses = createSuccessfulAlpacaResearchResponses(),
) =>
  vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input))
    if (url.pathname === "/v2/calendar") {
      return jsonResponse(responses.calendar)
    }
    if (url.pathname === "/v2/stocks/bars") {
      return jsonResponse(
        url.searchParams.get("timeframe") === "1Day"
          ? responses.dailyBars
          : responses.minuteBars,
      )
    }
    if (url.pathname === "/v2/options/contracts") {
      return jsonResponse(responses.contracts)
    }
    if (url.pathname === "/v1beta1/options/snapshots") {
      return jsonResponse(responses.snapshots)
    }
    if (url.pathname === "/v2/stocks/quotes/latest") {
      return jsonResponse(responses.quote)
    }
    return jsonResponse({}, 404)
  })

const createProvider = (
  fetchImplementation: typeof fetch,
  overrides: Partial<CreateAlpacaResearchSnapshotProviderOptions> = {},
) =>
  createAlpacaResearchSnapshotProvider({
    apiKey: "test-key",
    secretKey: "test-secret",
    fetch: fetchImplementation,
    now: createNow(),
    sleep: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  })

const capture = (
  provider: ReturnType<typeof createAlpacaResearchSnapshotProvider>,
  signal = new AbortController().signal,
) =>
  provider.capture({
    sessionDate: CAPTURE_SESSION_DATE,
    slotStartedAt: CAPTURE_SLOT_STARTED_AT,
    signal,
  })

describe("Alpaca research snapshot provider V1", () => {
  it("captures a complete canonical SPY snapshot pair without agent input", async () => {
    const fetchMock = createFixtureFetch()
    const provider = createProvider(fetchMock)

    const result = await capture(provider)

    expect(result.success).toBe(true)
    if (!result.success) throw new Error("Expected successful capture")
    expect(
      validateResearchSnapshotPairV1(result.underlying, result.optionUniverse),
    ).toMatchObject({ success: true })
    expect(result.underlying.dailyBars).toHaveLength(50)
    expect(result.underlying.minuteBars).toHaveLength(30)
    expect(result.underlying.underlyingQuote).toMatchObject({
      symbol: "SPY",
      bidMicrosPerShare: 635_100_000,
      askMicrosPerShare: 635_120_000,
    })
    expect(
      result.optionUniverse.contracts.map(({ contractSymbol }) => contractSymbol),
    ).toEqual([CALL_CONTRACT_SYMBOL, PUT_CONTRACT_SYMBOL])
    expect(result.optionUniverse.contracts[0]).toMatchObject({
      multiplier: 100,
      greeks: { deltaMillionths: 290_001 },
      currentSessionVolume: { contracts: 180 },
      openInterest: { asOfDate: "2026-08-27", contracts: 900 },
    })
    expect(result.optionUniverse.contracts[1]).toMatchObject({
      multiplier: 50,
      greeks: { deltaMillionths: -520_000 },
    })
    expect(Object.keys(provider)).toEqual(["capture"])

    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)))
    expect(urls.map(({ pathname }) => pathname)).toEqual([
      "/v2/calendar",
      "/v2/stocks/bars",
      "/v2/options/contracts",
      "/v1beta1/options/snapshots",
      "/v2/stocks/quotes/latest",
      "/v2/stocks/bars",
    ])
    expect(urls[1]!.searchParams.get("feed")).toBe("iex")
    expect(urls[1]!.searchParams.get("adjustment")).toBe("all")
    expect(urls[2]!.searchParams.get("underlying_symbols")).toBe("SPY")
    expect(urls[3]!.searchParams.get("feed")).toBe("indicative")
    expect(urls[3]!.searchParams.get("symbols")).toBe(
      `${CALL_CONTRACT_SYMBOL},${PUT_CONTRACT_SYMBOL}`,
    )
    expect(urls[4]!.searchParams.get("feed")).toBe("iex")
    expect(urls[5]!.searchParams.get("end")).toBe(
      "2026-08-28T13:59:59.999Z",
    )
    for (const [input, init] of fetchMock.mock.calls) {
      expect(String(input)).not.toContain("test-secret")
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: {
          "APCA-API-KEY-ID": "test-key",
          "APCA-API-SECRET-KEY": "test-secret",
        },
      })
      expect(init).not.toHaveProperty("body")
    }
  })

  it("produces the same IDs when provider records arrive in another order", async () => {
    const ordered = await capture(createProvider(createFixtureFetch()))
    const reversedResponses = createSuccessfulAlpacaResearchResponses()
    reversedResponses.calendar.reverse()
    reversedResponses.dailyBars.bars.SPY.reverse()
    reversedResponses.minuteBars.bars.SPY.reverse()
    reversedResponses.contracts.option_contracts.reverse()
    reversedResponses.snapshots.snapshots = Object.fromEntries(
      Object.entries(reversedResponses.snapshots.snapshots).reverse(),
    ) as typeof reversedResponses.snapshots.snapshots
    const reversed = await capture(
      createProvider(createFixtureFetch(reversedResponses)),
    )

    expect(ordered.success).toBe(true)
    expect(reversed.success).toBe(true)
    if (!ordered.success || !reversed.success) throw new Error("Expected captures")
    expect(reversed.underlying.snapshotId).toBe(ordered.underlying.snapshotId)
    expect(reversed.optionUniverse.snapshotId).toBe(
      ordered.optionUniverse.snapshotId,
    )
  })

  it("follows bars, contract, and option-snapshot pagination to terminal tokens", async () => {
    const responses = createSuccessfulAlpacaResearchResponses()
    const calls: URL[] = []
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      calls.push(url)
      const token = url.searchParams.get("page_token")
      if (url.pathname === "/v2/calendar") return jsonResponse(responses.calendar)
      if (url.pathname === "/v2/stocks/bars") {
        const source = url.searchParams.get("timeframe") === "1Day"
          ? responses.dailyBars.bars.SPY
          : responses.minuteBars.bars.SPY
        const split = source.length / 2
        return jsonResponse({
          bars: { SPY: token === null ? source.slice(0, split) : source.slice(split) },
          next_page_token: token === null ? "bars-next" : null,
        })
      }
      if (url.pathname === "/v2/options/contracts") {
        return jsonResponse({
          option_contracts: token === null
            ? responses.contracts.option_contracts.slice(0, 1)
            : responses.contracts.option_contracts.slice(1),
          next_page_token: token === null ? "contracts-next" : null,
        })
      }
      if (url.pathname === "/v1beta1/options/snapshots") {
        const entries = Object.entries(responses.snapshots.snapshots)
        return jsonResponse({
          snapshots: Object.fromEntries(token === null ? entries.slice(0, 1) : entries.slice(1)),
          next_page_token: token === null ? "snapshots-next" : null,
        })
      }
      if (url.pathname === "/v2/stocks/quotes/latest") {
        return jsonResponse(responses.quote)
      }
      return jsonResponse({}, 404)
    })

    const result = await capture(createProvider(fetchMock))

    expect(result.success).toBe(true)
    expect(
      calls.filter((url) => url.searchParams.has("page_token"))
        .map((url) => url.searchParams.get("page_token")),
    ).toEqual([
      "bars-next",
      "contracts-next",
      "snapshots-next",
      "bars-next",
    ])
  })

  it("retries rate limits with bounded Retry-After handling", async () => {
    const responses = createSuccessfulAlpacaResearchResponses()
    const baseFetch = createFixtureFetch(responses)
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 429, { "retry-after": "1" }))
      .mockImplementation(baseFetch)
    const sleep = vi.fn().mockResolvedValue(undefined)

    const result = await capture(createProvider(fetchMock, { sleep }))

    expect(result.success).toBe(true)
    expect(sleep).toHaveBeenCalledWith(1_000, expect.any(AbortSignal))
  })

  it("returns bounded provider and malformed-response failures", async () => {
    const providerFailure = createProvider(
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 503)),
      { maxAttempts: 1 },
    )
    const malformed = createProvider(
      vi.fn<typeof fetch>().mockResolvedValue(new Response("{", { status: 200 })),
    )

    await expect(capture(providerFailure)).resolves.toEqual({
      success: false,
      reasons: ["CALENDAR_REQUEST_FAILED"],
    })
    await expect(capture(malformed)).resolves.toEqual({
      success: false,
      reasons: ["CALENDAR_RESPONSE_INVALID"],
    })
  })

  it("propagates cancellation during an in-flight request", async () => {
    const reason = new DOMException("Stopped", "AbortError")
    const controller = new AbortController()
    const provider = createProvider(
      vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {})),
    )

    const pending = capture(provider, controller.signal)
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })

  it("propagates cancellation during response-body parsing", async () => {
    const reason = new DOMException("Stopped", "AbortError")
    const controller = new AbortController()
    const response = jsonResponse([])
    response.json = vi.fn(() => {
      controller.abort(reason)
      return new Promise(() => {})
    })
    const provider = createProvider(
      vi.fn<typeof fetch>().mockResolvedValue(response),
    )

    await expect(capture(provider, controller.signal)).rejects.toBe(reason)
  })

  it("bounds a transport that ignores request cancellation", async () => {
    const provider = createProvider(
      vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {})),
      { maxAttempts: 1, requestTimeoutMs: 100 },
    )

    await expect(capture(provider)).resolves.toEqual({
      success: false,
      reasons: ["REQUEST_TIMED_OUT"],
    })
  })

  it("propagates cancellation during retry backoff", async () => {
    const reason = new DOMException("Stopped", "AbortError")
    const controller = new AbortController()
    const sleep = vi.fn((_milliseconds: number, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        })
      }),
    )
    const provider = createProvider(
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 429)),
      { sleep },
    )

    const pending = capture(provider, controller.signal)
    await vi.waitFor(() => expect(sleep).toHaveBeenCalled())
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })

  it("returns a bounded code after exhausting rate-limit retries", async () => {
    const provider = createProvider(
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 429)),
      { maxAttempts: 1 },
    )

    await expect(capture(provider)).resolves.toEqual({
      success: false,
      reasons: ["PROVIDER_RATE_LIMITED"],
    })
  })

  it.each([
    ["stale quote", (responses: ReturnType<typeof createSuccessfulAlpacaResearchResponses>) => {
      responses.quote.quotes.SPY.t = "2026-08-28T13:58:00.000Z"
    }, "OBSERVATION_STALE"],
    ["missing minute", (responses: ReturnType<typeof createSuccessfulAlpacaResearchResponses>) => {
      responses.minuteBars.bars.SPY.pop()
    }, "DATA_INCOMPLETE"],
    ["duplicate daily bar", (responses: ReturnType<typeof createSuccessfulAlpacaResearchResponses>) => {
      responses.dailyBars.bars.SPY[1] = structuredClone(responses.dailyBars.bars.SPY[0]!)
    }, "DUPLICATE_RECORD"],
    ["mixed stock symbol", (responses: ReturnType<typeof createSuccessfulAlpacaResearchResponses>) => {
      Object.assign(responses.dailyBars.bars, { QQQ: [responses.dailyBars.bars.SPY[0]!] })
    }, "DATA_CONTAMINATED"],
    ["mixed contract symbol", (responses: ReturnType<typeof createSuccessfulAlpacaResearchResponses>) => {
      responses.contracts.option_contracts[0]!.underlying_symbol = "QQQ"
    }, "DATA_CONTAMINATED"],
    ["missing greeks", (responses: ReturnType<typeof createSuccessfulAlpacaResearchResponses>) => {
      delete (responses.snapshots.snapshots[CALL_CONTRACT_SYMBOL] as Partial<
        typeof responses.snapshots.snapshots[typeof CALL_CONTRACT_SYMBOL]
      >).greeks
    }, "OPTION_SNAPSHOTS_RESPONSE_INVALID"],
    ["stale option quote", (responses: ReturnType<typeof createSuccessfulAlpacaResearchResponses>) => {
      responses.snapshots.snapshots[CALL_CONTRACT_SYMBOL].latestQuote.t =
        "2026-08-28T13:58:00.000Z"
    }, "OBSERVATION_STALE"],
    ["stale open interest", (responses: ReturnType<typeof createSuccessfulAlpacaResearchResponses>) => {
      responses.contracts.option_contracts[0]!.open_interest_date = "2026-08-20"
    }, "OBSERVATION_STALE"],
    ["mixed option snapshot", (responses: ReturnType<typeof createSuccessfulAlpacaResearchResponses>) => {
      Object.assign(responses.snapshots.snapshots, {
        QQQ260911C00600000: structuredClone(
          responses.snapshots.snapshots[CALL_CONTRACT_SYMBOL],
        ),
      })
    }, "DATA_CONTAMINATED"],
    ["fractional-cent option quote", (responses: ReturnType<typeof createSuccessfulAlpacaResearchResponses>) => {
      responses.snapshots.snapshots[CALL_CONTRACT_SYMBOL].latestQuote.bp = "1.205"
    }, "OPTION_SNAPSHOTS_RESPONSE_INVALID"],
    ["future quote", (responses: ReturnType<typeof createSuccessfulAlpacaResearchResponses>) => {
      responses.quote.quotes.SPY.t = "2026-08-28T14:01:00.0001Z"
    }, "OBSERVATION_FROM_FUTURE"],
  ])("fails closed for %s", async (_name, mutate, expectedReason) => {
    const responses = createSuccessfulAlpacaResearchResponses()
    mutate(responses)

    await expect(capture(createProvider(createFixtureFetch(responses)))).resolves
      .toEqual({ success: false, reasons: [expectedReason] })
  })

  it("rejects an empty terminal SPY contract universe", async () => {
    const responses = createSuccessfulAlpacaResearchResponses()
    responses.contracts.option_contracts = []

    await expect(capture(createProvider(createFixtureFetch(responses)))).resolves
      .toEqual({ success: false, reasons: ["DATA_INCOMPLETE"] })
  })

  it("rejects duplicate contracts before joining snapshots", async () => {
    const responses = createSuccessfulAlpacaResearchResponses()
    responses.contracts.option_contracts.push(
      structuredClone(responses.contracts.option_contracts[0]!),
    )

    await expect(capture(createProvider(createFixtureFetch(responses)))).resolves
      .toEqual({ success: false, reasons: ["DUPLICATE_RECORD"] })
  })

  it("rejects contract pagination that exceeds its bounded page count", async () => {
    const responses = createSuccessfulAlpacaResearchResponses()
    let contractPage = 0
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/calendar") return jsonResponse(responses.calendar)
      if (url.pathname === "/v2/stocks/bars") return jsonResponse(responses.dailyBars)
      if (url.pathname === "/v2/options/contracts") {
        const strike = 500 + contractPage
        const symbol = `SPY260911C${String(strike * 1_000).padStart(8, "0")}`
        contractPage += 1
        return jsonResponse({
          option_contracts: [{
            ...responses.contracts.option_contracts[0],
            symbol,
            strike_price: String(strike),
          }],
          next_page_token: `page-${contractPage}`,
        })
      }
      return jsonResponse({}, 500)
    })

    await expect(capture(createProvider(fetchMock))).resolves.toEqual({
      success: false,
      reasons: ["PAGINATION_INCOMPLETE"],
    })
    expect(contractPage).toBe(10)
  })

  it.each([
    ["omitted", undefined],
    ["empty", ""],
  ])("rejects %s terminal pagination evidence", async (_name, token) => {
    const responses = createSuccessfulAlpacaResearchResponses()
    const dailyBars = {
      bars: responses.dailyBars.bars,
      ...(token === undefined ? {} : { next_page_token: token }),
    }
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/calendar") return jsonResponse(responses.calendar)
      if (url.pathname === "/v2/stocks/bars") return jsonResponse(dailyBars)
      return jsonResponse({}, 500)
    })

    await expect(capture(createProvider(fetchMock))).resolves.toEqual({
      success: false,
      reasons: ["DAILY_BARS_RESPONSE_INVALID"],
    })
  })

  it("rejects repeated nonterminal pagination tokens", async () => {
    const responses = createSuccessfulAlpacaResearchResponses()
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/calendar") return jsonResponse(responses.calendar)
      if (url.pathname === "/v2/stocks/bars" && url.searchParams.get("timeframe") === "1Day") {
        return jsonResponse({
          bars: { SPY: responses.dailyBars.bars.SPY.slice(0, 1) },
          next_page_token: "same-token",
        })
      }
      return jsonResponse({}, 500)
    })

    await expect(capture(createProvider(fetchMock))).resolves.toEqual({
      success: false,
      reasons: ["PAGINATION_INCOMPLETE"],
    })
  })

  it("never returns credentials or raw provider payloads", async () => {
    const marker = "must-not-leak"
    const provider = createAlpacaResearchSnapshotProvider({
      apiKey: marker,
      secretKey: marker,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(marker, { status: 500 }),
      ),
      now: createNow(),
      maxAttempts: 1,
    })

    const result = await capture(provider)

    expect(JSON.stringify(result)).not.toContain(marker)
  })

  it.each([
    "http://data.alpaca.markets",
    "https://user:password@data.alpaca.markets",
    "https://example.com",
  ])("rejects unsafe production data URL %s", (dataBaseUrl) => {
    expect(() =>
      createAlpacaResearchSnapshotProvider({
        apiKey: "key",
        secretKey: "secret",
        dataBaseUrl,
      }),
    ).toThrow("credential-free Alpaca HTTPS URL")
  })
})
