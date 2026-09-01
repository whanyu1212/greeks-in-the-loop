import { describe, expect, it } from "vitest"

import {
  AlpacaBarProxyError,
  deriveOptionPricingProxyV1,
  runAlpacaBarProxyBacktest,
} from "../src/backtest/alpaca-bar-proxy.js"

const longSymbol = "SPY250131C00580000"
const shortSymbol = "SPY250131C00585000"

const manifest = (overrides: Record<string, unknown> = {}) => ({
  manifestVersion: "1.0.0",
  initialEquityCents: 10_000_000,
  monitoring: { cadenceMinutes: 30 },
  exitPolicy: {
    stopLossBpsOfMaxLoss: 5_000,
    profitTargetBps: 3_000,
    minimumDte: 3,
    maxHoldingSessions: 5,
  },
  marketAssumptions: {
    interestRateBps: 450,
    assumedOpenInterest: 600,
    dividendYieldBpsByUnderlying: { SPY: 120 },
  },
  accountAssumptions: {
    buyingPowerCents: 20_000_000,
    cashCents: 20_000_000,
    equityCents: 10_000_000,
  },
  sensitivityBands: [
    {
      name: "OPTIMISTIC",
      spreadBps: 100,
      minimumSpreadCents: 1,
      entrySlippageCentsPerLeg: 0,
      exitSlippageCentsPerLeg: 0,
      commissionCentsPerContract: 50,
    },
    {
      name: "BASE",
      spreadBps: 150,
      minimumSpreadCents: 1,
      entrySlippageCentsPerLeg: 1,
      exitSlippageCentsPerLeg: 2,
      commissionCentsPerContract: 50,
    },
    {
      name: "CONSERVATIVE",
      spreadBps: 200,
      minimumSpreadCents: 1,
      entrySlippageCentsPerLeg: 3,
      exitSlippageCentsPerLeg: 5,
      commissionCentsPerContract: 50,
    },
  ],
  scenarios: [{
    scenarioId: "spy-bull-call-2025-01-10",
    underlying: "SPY",
    strategy: "BULL_CALL_SPREAD",
    entryAt: "2025-01-10T15:00:00.000Z",
    legs: [
      { symbol: longSymbol, intent: "BUY_TO_OPEN" },
      { symbol: shortSymbol, intent: "SELL_TO_OPEN" },
    ],
  }],
  ...overrides,
})

const sessions = [
  ["2025-01-10", "09:30", "16:00"],
  ["2025-01-13", "09:30", "16:00"],
  ["2025-01-14", "09:30", "16:00"],
  ["2025-01-15", "09:30", "16:00"],
  ["2025-01-16", "09:30", "16:00"],
].map(([date, open, close]) => ({ date, open, close }))

const bar = (timestamp: string, close: number, volume = 150) => ({
  t: timestamp,
  o: close,
  h: close,
  l: close,
  c: close,
  v: volume,
  n: 1,
  vw: close,
})

const response = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
})

const mockFetch = (options: Readonly<{
  monitorBars?: boolean
  futureBars?: boolean
  paginateOptions?: boolean
  optionPrices?: readonly [number, number]
}> = {}) => {
  const requests: URL[] = []
  const request: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push(url)
    if (url.pathname === "/v2/calendar") return response(sessions)
    if (url.pathname === "/v1beta1/options/bars") {
      const entryPrices = options.optionPrices ?? [5, 2.5]
      const longBars = [bar("2025-01-10T14:59:00.000Z", entryPrices[0])]
      const shortBars = [bar("2025-01-10T14:59:00.000Z", entryPrices[1])]
      if (options.futureBars) {
        longBars.push(bar("2025-01-10T15:00:00.000Z", 50, 999))
        shortBars.push(bar("2025-01-10T15:00:00.000Z", 25, 999))
      }
      if (options.monitorBars !== false) {
        longBars.push(bar("2025-01-10T15:29:00.000Z", 7))
        shortBars.push(bar("2025-01-10T15:29:00.000Z", 2))
      }
      if (options.paginateOptions) {
        if (url.searchParams.get("page_token") === null) {
          return response({
            bars: { [longSymbol]: longBars },
            next_page_token: "short-leg",
          })
        }
        return response({ bars: { [shortSymbol]: shortBars }, next_page_token: null })
      }
      return response({
        bars: { [longSymbol]: longBars, [shortSymbol]: shortBars },
        next_page_token: null,
      })
    }
    if (url.pathname === "/v2/stocks/SPY/bars") {
      return url.searchParams.get("timeframe") === "1Min"
        ? response({
            bars: [bar("2025-01-10T14:59:00.000Z", 580, 1_000)],
            next_page_token: null,
          })
        : response({ bars: [], next_page_token: null })
    }
    return new Response(null, { status: 404 })
  }
  return { request, requests }
}

const run = (
  input: unknown,
  request: typeof fetch,
) => runAlpacaBarProxyBacktest(input, {
  apiKey: "key-value",
  secretKey: "secret-value",
  dataBaseUrl: "https://data.example.test",
  tradingBaseUrl: "https://trading.example.test",
  fetch: request,
  now: () => new Date("2026-01-01T00:00:00.000Z"),
})

describe("Alpaca option-bar proxy backtest", () => {
  it("derives bounded Black-Scholes proxy metrics without a dependency", () => {
    const call = deriveOptionPricingProxyV1({
      optionType: "C",
      optionPrice: 10.4506,
      underlyingPrice: 100,
      strikePrice: 100,
      yearsToExpiration: 1,
      interestRate: 0.05,
      dividendYield: 0,
    })
    const put = deriveOptionPricingProxyV1({
      optionType: "P",
      optionPrice: 5.5735,
      underlyingPrice: 100,
      strikePrice: 100,
      yearsToExpiration: 1,
      interestRate: 0.05,
      dividendYield: 0,
    })

    expect(call?.impliedVolatility).toBeCloseTo(0.2, 3)
    expect(call?.delta).toBeCloseTo(0.6368, 3)
    expect(put?.impliedVolatility).toBeCloseTo(0.2, 3)
    expect(put?.delta).toBeCloseTo(-0.3632, 3)
    expect(deriveOptionPricingProxyV1({
      optionType: "C",
      optionPrice: 200,
      underlyingPrice: 100,
      strikePrice: 100,
      yearsToExpiration: 1,
      interestRate: 0,
      dividendYield: 0,
    })).toBeUndefined()
  })

  it("generates retained V8 inputs and three sensitivity replays", async () => {
    const { request, requests } = mockFetch()
    const report = await run(manifest(), request)

    expect(report).toMatchObject({
      reportVersion: "1.0.0",
      proxyAssumptions: {
        optionSource: "ALPACA_ACCOUNT_DEFAULT_OPTION_TRADES_1MIN_PROXY",
        riskInterpretation: "CONDITIONAL_ON_PROXY_ASSUMPTIONS",
      },
      staticFailures: [],
      bands: [
        { name: "OPTIMISTIC", coverage: { requested: 1, generated: 1, rejected: 0 } },
        { name: "BASE", coverage: { requested: 1, generated: 1, rejected: 0 } },
        { name: "CONSERVATIVE", coverage: { requested: 1, generated: 1, rejected: 0 } },
      ],
    })
    const baseReplay = report.bands[1]!.replay as {
      scenarios: Array<{
        risk: { outcome: string }
        simulation: { outcome: string; exitReason: string }
      }>
    }
    expect(baseReplay.scenarios[0]).toMatchObject({
      risk: { outcome: "APPROVED" },
      simulation: { outcome: "CLOSED", exitReason: "PROFIT_TARGET" },
    })
    const replayInput = report.bands[1]!.replayInput as {
      scenarios: Array<{
        riskInput: {
          intent: {
            legs: Array<{ quote: { providerTimestamp: string } }>
          }
        }
        monitorCycles: Array<Record<string, unknown>>
      }>
    }
    expect(replayInput.scenarios[0]!.riskInput.intent.legs[0]!.quote)
      .toMatchObject({ providerTimestamp: "2025-01-10T15:00:00.000Z" })
    expect(replayInput.scenarios[0]!.monitorCycles[0]).toMatchObject({
      decidedAt: "2025-01-10T15:30:00.000Z",
      staleMinutes: 0,
    })
    expect(requests.find(({ pathname }) => pathname.includes("options/bars"))
      ?.searchParams.has("feed")).toBe(false)
    expect(requests.find(({ pathname, searchParams }) =>
      pathname.includes("stocks") && searchParams.get("timeframe") === "1Min"
    )?.searchParams.get("feed")).toBe("iex")
  })

  it("ignores incomplete entry bars and leaves five-minute stale exits unpriced", async () => {
    const { request } = mockFetch({ monitorBars: false, futureBars: true })
    const report = await run(manifest(), request)
    const replayInput = report.bands[0]!.replayInput as {
      scenarios: Array<{
        riskInput: {
          intent: { legs: Array<{ quote: { askCentsPerShare: number } }> }
        }
        monitorCycles: Array<Record<string, unknown>>
      }>
    }
    const scenario = replayInput.scenarios[0]!

    expect(scenario.riskInput.intent.legs[0]!.quote.askCentsPerShare).toBeLessThan(1_000)
    expect(scenario.monitorCycles[0]).toMatchObject({ staleMinutes: 29 })
    expect(scenario.monitorCycles[0]).not.toHaveProperty(
      "closePremiumCentsPerStrategyUnit",
    )
    const replay = report.bands[0]!.replay as {
      scenarios: Array<{ simulation: { outcome: string; exitReason: string } }>
    }
    expect(replay.scenarios[0]!.simulation).toMatchObject({
      outcome: "EXIT_UNPRICED",
      exitReason: "STALE_DATA",
    })
    expect(report.sensitivityClassification).toBe("INCOMPLETE")
  })

  it("follows option-bar pagination across symbols", async () => {
    const { request, requests } = mockFetch({ paginateOptions: true })
    const report = await run(manifest(), request)

    expect(report.staticFailures).toEqual([])
    expect(requests.filter(({ pathname }) => pathname.includes("options/bars")))
      .toHaveLength(2)
  })

  it("retains band-specific proxy failures instead of dropping them", async () => {
    const { request } = mockFetch({ optionPrices: [0.01, 0.01] })
    const report = await run(manifest(), request)

    expect(report.bands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        coverage: { requested: 1, generated: 0, rejected: 1 },
        scenarioFailures: [{
          scenarioId: "spy-bull-call-2025-01-10",
          code: "SYNTHETIC_QUOTE_INVALID",
        }],
        replay: null,
      }),
    ]))
    expect(report.sensitivityClassification).toBe("INCOMPLETE")
  })

  it("rejects malformed manifests before making a request", async () => {
    const { request, requests } = mockFetch()

    await expect(run({ manifestVersion: "1.0.0" }, request)).rejects.toEqual(
      new AlpacaBarProxyError("MANIFEST_INVALID"),
    )
    await expect(run(manifest({
      exitPolicy: {
        stopLossBpsOfMaxLoss: 5_000,
        profitTargetBps: 3_000,
        minimumDte: 3,
        maxHoldingSessions: 21,
      },
    }), request)).rejects.toEqual(new AlpacaBarProxyError("MANIFEST_INVALID"))
    expect(requests).toEqual([])
  })
})
