import { describe, expect, it, vi } from "vitest"

import {
  createAlpacaRiskStateProvider,
  type RiskStateCaptureFailureCode,
} from "../src/risk/alpaca-risk-state-provider.js"
import { DURABLE_RISK_CONTROL_STATE_VERSION } from "../src/risk/risk-state-v1.js"

const sessionDate = "2026-08-27"
const evaluatedAt = new Date("2026-08-27T14:30:30.000Z")
const longSymbol = "SPY260918C00600000"
const shortSymbol = "SPY260918C00605000"
const signal = new AbortController().signal

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const account = {
  status: "ACTIVE",
  trading_blocked: false,
  account_blocked: false,
  trade_suspended_by_user: false,
  options_approved_level: 3,
  options_trading_level: 3,
  buying_power: "100000.00",
  equity: "100000.00",
  last_equity: "100000.00",
}

const contract = (symbol: string) => ({
  symbol,
  status: "active",
  tradable: true,
  style: "american",
  size: "100",
  open_interest: "750",
  open_interest_date: "2026-08-26",
})

const optionSnapshot = (delta: number) => ({
  latestQuote: {
    bp: "2.00",
    ap: "2.10",
    t: "2026-08-27T14:30:00.123456789Z",
  },
  greeks: { delta, gamma: 0.02, theta: -0.04, vega: 0.12 },
  impliedVolatility: 0.25,
  dailyBar: { t: "2026-08-27T13:30:00Z", v: 250 },
})

const snapshots = {
  snapshots: {
    [longSymbol]: optionSnapshot(0.5),
    [shortSymbol]: optionSnapshot(0.3),
  },
}

const openingOrder = (overrides: Record<string, unknown> = {}) => ({
  id: "order-1",
  asset_class: "us_option",
  submitted_at: "2026-08-27T14:29:00.000Z",
  status: "rejected",
  order_class: "mleg",
  type: "limit",
  time_in_force: "day",
  qty: "1",
  legs: [
    { symbol: longSymbol, ratio_qty: "1", position_intent: "buy_to_open" },
    { symbol: shortSymbol, ratio_qty: "1", position_intent: "sell_to_open" },
  ],
  ...overrides,
})

const closingOrder = (overrides: Record<string, unknown> = {}) =>
  openingOrder({
    id: "closing-order",
    status: "filled",
    legs: [
      { symbol: longSymbol, ratio_qty: "1", position_intent: "sell_to_close" },
      { symbol: shortSymbol, ratio_qty: "1", position_intent: "buy_to_close" },
    ],
    ...overrides,
  })

const input = {
  sessionDate,
  slotStartedAt: "2026-08-27T14:30:00.000Z",
  longContractSymbol: longSymbol,
  shortContractSymbol: shortSymbol,
  durableControl: {
    stateVersion: DURABLE_RISK_CONTROL_STATE_VERSION,
    tradingDate: sessionDate,
    entriesSubmittedToday: 0,
    dailyBreakerActive: false,
    competitionBreakerActive: false,
  },
  signal,
} as const

const router = (overrides: Readonly<{
  account?: unknown
  positions?: (call: number) => unknown
  openOrders?: (call: number, url: URL) => unknown
  history?: unknown | ((call: number, url: URL) => unknown)
  snapshots?: unknown
}> = {}) => {
  let positionsCall = 0
  let openOrdersCall = 0
  let historyCall = 0
  return vi.fn<typeof fetch>(async (resource, init) => {
    const url = new URL(String(resource))
    expect(init?.method).toBe("GET")
    expect(init?.redirect).toBe("error")
    if (url.pathname === "/v2/account") return response(overrides.account ?? account)
    if (url.pathname === "/v2/positions") {
      positionsCall += 1
      return response(overrides.positions?.(positionsCall) ?? [])
    }
    if (url.pathname === "/v2/orders") {
      if (url.searchParams.get("status") === "open") {
        openOrdersCall += 1
        return response(overrides.openOrders?.(openOrdersCall, url) ?? [])
      }
      historyCall += 1
      return response(
        typeof overrides.history === "function"
          ? overrides.history(historyCall, url)
          : overrides.history ?? [],
      )
    }
    if (url.pathname === `/v2/options/contracts/${longSymbol}`) {
      return response(contract(longSymbol))
    }
    if (url.pathname === `/v2/options/contracts/${shortSymbol}`) {
      return response(contract(shortSymbol))
    }
    if (url.pathname === "/v1beta1/options/snapshots") {
      expect(url.searchParams.get("symbols")).toBe(`${longSymbol},${shortSymbol}`)
      expect(url.searchParams.get("feed")).toBe("indicative")
      return response(overrides.snapshots ?? snapshots)
    }
    return response({}, 404)
  })
}

const provider = (
  fetchImplementation: typeof fetch,
  now: () => Date = () => evaluatedAt,
) =>
  createAlpacaRiskStateProvider({
    apiKey: "test-key",
    secretKey: "test-secret",
    fetch: fetchImplementation,
    now,
  })

const expectFailure = async (
  fetchImplementation: typeof fetch,
  expected: RiskStateCaptureFailureCode,
) => {
  const result = await provider(fetchImplementation).capture(input)
  expect(result).toEqual({ success: false, reasons: [expected] })
}

describe("Alpaca risk-state provider", () => {
  it("exposes only one read-only capture operation", () => {
    expect(Object.keys(provider(router()))).toEqual(["capture"])
  })

  it("coordinates application-verified account, contract, quote, and flat portfolio state", async () => {
    const fetchImplementation = router()
    const result = await provider(fetchImplementation).capture(input)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.snapshot).toMatchObject({
      evaluatedAt: evaluatedAt.toISOString(),
      quoteSnapshot: {
        evaluatedAt: evaluatedAt.toISOString(),
        snapshotMetadata: {
          provider: "ALPACA",
          source: "options-snapshots-indicative",
          retrievedAt: evaluatedAt.toISOString(),
        },
      },
      account: {
        observedAt: evaluatedAt.toISOString(),
        status: "ACTIVE",
        tradingRestricted: false,
        multilegOptionsApproved: true,
        buyingPowerCents: 10_000_000,
      },
      portfolio: {
        observedAt: evaluatedAt.toISOString(),
        consistent: true,
      },
      contracts: {
        slotStartedAt: input.slotStartedAt,
        observedAt: evaluatedAt.toISOString(),
        legs: [
          { role: "LONG", volume: 250, volumeDate: sessionDate },
          { role: "SHORT", volume: 250, volumeDate: sessionDate },
        ],
      },
      reconciliationReasonCodes: [],
    })
    expect(fetchImplementation).toHaveBeenCalledTimes(9)
    for (const [resource, init] of fetchImplementation.mock.calls) {
      expect(String(resource)).not.toContain("test-key")
      expect(String(resource)).not.toContain("test-secret")
      expect(init?.headers).toEqual({
        "APCA-API-KEY-ID": "test-key",
        "APCA-API-SECRET-KEY": "test-secret",
      })
    }
  })

  it("sets reconciliation inconsistent when broker state changes during capture", async () => {
    const longPosition = {
      asset_class: "us_option",
      symbol: longSymbol,
      qty: "1",
      side: "long",
    }
    const shortPosition = {
      asset_class: "us_option",
      symbol: shortSymbol,
      qty: "1",
      side: "short",
    }
    const result = await provider(router({
      positions: (call) => call === 1 ? [] : [longPosition, shortPosition],
    })).capture(input)
    expect(result.success && result.snapshot.portfolio).toMatchObject({
      consistent: false,
      openStrategyPositionCount: 1,
    })
    expect(result.success && result.snapshot.reconciliationReasonCodes).toEqual([
      "BROKER_STATE_CHANGED",
    ])
  })

  it("normalizes Alpaca negative quantity for short positions", async () => {
    const longPosition = {
      asset_class: "us_option",
      symbol: longSymbol,
      qty: "1",
      side: "long",
    }
    const shortPosition = {
      asset_class: "us_option",
      symbol: shortSymbol,
      qty: "-1",
      side: "short",
    }
    const result = await provider(router({
      positions: () => [longPosition, shortPosition],
    })).capture(input)
    expect(result.success && result.snapshot.portfolio).toMatchObject({
      consistent: true,
      openStrategyPositionCount: 1,
    })
  })

  it("reconciles valid unrelated fractional exposure as inconsistent state", async () => {
    const result = await provider(router({
      positions: () => [{
        asset_class: "us_equity",
        symbol: "SPY",
        qty: "0.25",
        side: "long",
      }],
    })).capture(input)
    expect(result.success && result.snapshot.portfolio).toMatchObject({
      consistent: false,
      openStrategyPositionCount: 0,
    })
    expect(result.success && result.snapshot.reconciliationReasonCodes).toEqual([
      "UNKNOWN_POSITION",
    ])
  })

  it("counts only same-day submitted entries observed by capture start", async () => {
    const result = await provider(router({
      history: [
        openingOrder({ id: "previous-day", submitted_at: "2026-08-26T18:00:00.000Z" }),
        openingOrder({ id: "observed" }),
        openingOrder({ id: "after-capture", submitted_at: "2026-08-27T14:30:31.000Z" }),
      ],
    })).capture(input)
    expect(result.success && result.snapshot.portfolio.entriesSubmittedToday).toBe(1)
  })

  it("does not count recognized closing-only option orders as same-day entries", async () => {
    const result = await provider(router({
      history: [closingOrder()],
    })).capture(input)
    expect(result.success && result.snapshot.portfolio.entriesSubmittedToday).toBe(0)
  })

  it("does not count simple single-leg option closes as entries", async () => {
    const result = await provider(router({
      history: [openingOrder({
        id: "simple-close",
        status: "filled",
        order_class: "simple",
        position_intent: "sell_to_close",
        legs: null,
      })],
    })).capture(input)
    expect(result.success && result.snapshot.portfolio.entriesSubmittedToday).toBe(0)
  })

  it("accepts valid notional orders without treating them as option entries", async () => {
    const notionalOrder = {
      id: "notional-order",
      asset_class: "us_equity",
      submitted_at: "2026-08-27T14:29:00.000Z",
      status: "accepted",
      order_class: "simple",
      type: "market",
      time_in_force: "day",
      qty: null,
      notional: "100.00",
    }
    const result = await provider(router({
      openOrders: () => [notionalOrder],
      history: [notionalOrder],
    })).capture(input)
    expect(result.success && result.snapshot.portfolio).toMatchObject({
      consistent: false,
      entriesSubmittedToday: 0,
    })
    expect(result.success && result.snapshot.reconciliationReasonCodes).toEqual([
      "UNKNOWN_OPEN_ORDER",
      "UNMATCHED_PENDING_ENTRY",
    ])
  })

  it("paginates order history with the supported timestamp cursor", async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      id: `equity-order-${index}`,
      asset_class: "us_equity",
      submitted_at: new Date(
        Date.parse("2026-08-27T13:00:00.000Z") + index,
      ).toISOString().replace("Z", "123456Z"),
      status: "filled",
      order_class: "simple",
      type: "market",
      time_in_force: "day",
      qty: "1",
    }))
    const overlapTimestamp = firstPage.at(-2)?.submitted_at
    const historyUrls: URL[] = []
    const result = await provider(router({
      history: (call: number, url: URL) => {
        historyUrls.push(new URL(url))
        return call === 1 ? firstPage : []
      },
    })).capture(input)
    expect(result.success).toBe(true)
    expect(historyUrls).toHaveLength(2)
    expect(historyUrls[1]?.searchParams.get("after")).toBe(overlapTimestamp)
    expect(historyUrls[1]?.searchParams.get("until")).toBe(
      evaluatedAt.toISOString(),
    )
    expect(historyUrls[1]?.searchParams.has("after_order_id")).toBe(false)
  })

  it("overlaps and deduplicates tied order-pagination boundaries", async () => {
    const firstPage = Array.from({ length: 499 }, (_, index) => ({
      id: `earlier-equity-order-${index}`,
      asset_class: "us_equity",
      submitted_at: new Date(
        Date.parse("2026-08-27T13:00:00.000Z") + index,
      ).toISOString(),
      status: "filled",
      order_class: "simple",
      type: "market",
      time_in_force: "day",
      qty: "1",
    }))
    const boundaryOrder = {
      ...firstPage.at(-1)!,
      id: "boundary-order",
      submitted_at: "2026-08-27T13:00:01.000123456Z",
    }
    firstPage.push(boundaryOrder)
    const secondTiedOrder = { ...boundaryOrder, id: "second-tied-order" }
    const historyUrls: URL[] = []
    const result = await provider(router({
      history: (call: number, url: URL) => {
        historyUrls.push(new URL(url))
        return call === 1 ? firstPage : [boundaryOrder, secondTiedOrder]
      },
    })).capture(input)
    expect(result.success).toBe(true)
    expect(historyUrls[1]?.searchParams.get("after")).toBe(
      firstPage.at(-2)?.submitted_at,
    )
  })

  it("fails closed when a full tied page has no safe pagination cursor", async () => {
    const tiedPage = Array.from({ length: 500 }, (_, index) => ({
      id: `tied-equity-order-${index}`,
      asset_class: "us_equity",
      submitted_at: "2026-08-27T13:00:00.000123456Z",
      status: "filled",
      order_class: "simple",
      type: "market",
      time_in_force: "day",
      qty: "1",
    }))
    await expectFailure(
      router({ history: tiedPage }),
      "ORDER_HISTORY_INCOMPLETE",
    )
  })

  it("captures terminal orders submitted during the capture interval", async () => {
    const requestStartedAt = new Date("2026-08-27T14:30:30.000Z")
    const captureFinishedAt = new Date("2026-08-27T14:30:31.000Z")
    const duringCapture = openingOrder({
      status: "rejected",
      submitted_at: "2026-08-27T14:30:30.500123456Z",
    })
    const historyUrls: URL[] = []
    const fetchImplementation = router({
      history: (_call: number, url: URL) => {
        historyUrls.push(new URL(url))
        return [duringCapture]
      },
    })
    const now = vi.fn()
      .mockReturnValueOnce(requestStartedAt)
      .mockReturnValueOnce(captureFinishedAt)
    const result = await provider(fetchImplementation, now).capture(input)
    expect(result.success && result.snapshot.portfolio).toMatchObject({
      consistent: false,
      entriesSubmittedToday: 1,
    })
    expect(result.success && result.snapshot.reconciliationReasonCodes).toEqual([
      "BROKER_STATE_CHANGED",
    ])
    expect(historyUrls[0]?.searchParams.get("until")).toBe(
      captureFinishedAt.toISOString(),
    )
  })

  it("rejects capture when the evaluation clock moves backward", async () => {
    const fetchImplementation = router()
    const now = vi.fn()
      .mockReturnValueOnce(new Date("2026-08-27T14:30:30.000Z"))
      .mockReturnValueOnce(new Date("2026-08-27T14:30:29.999Z"))
    const result = await provider(fetchImplementation, now).capture(input)
    expect(result).toEqual({
      success: false,
      reasons: ["CAPTURE_TIME_INVALID"],
    })
    expect(fetchImplementation.mock.calls.some(([resource]) => {
      const url = new URL(String(resource))
      return url.pathname === "/v2/orders" &&
        url.searchParams.get("status") === "all"
    })).toBe(false)
  })

  it("fails closed on malformed account money", async () => {
    await expectFailure(
      router({ account: { ...account, buying_power: "100.001" } }),
      "ACCOUNT_RESPONSE_INVALID",
    )
  })

  it("returns bounded failures without raw payloads or credentials", async () => {
    const fetchImplementation = router({
      account: {
        ...account,
        buying_power: "test-secret-100.001",
      },
    })
    const result = await provider(fetchImplementation).capture(input)
    expect(result).toEqual({
      success: false,
      reasons: ["ACCOUNT_RESPONSE_INVALID"],
    })
    expect(JSON.stringify(result)).not.toContain("test-secret")
  })

  it("fails closed when required option metrics are absent", async () => {
    const missingGreeks = structuredClone(snapshots) as Record<string, any>
    delete missingGreeks.snapshots[longSymbol].greeks
    await expectFailure(
      router({ snapshots: missingGreeks }),
      "OPTION_METRICS_UNAVAILABLE",
    )
  })

  it("rejects blank provider numerics instead of coercing them to zero", async () => {
    const blankGamma = structuredClone(snapshots) as Record<string, any>
    blankGamma.snapshots[longSymbol].greeks.gamma = " "
    await expectFailure(
      router({ snapshots: blankGamma }),
      "OPTION_METRICS_UNAVAILABLE",
    )
  })

  it("rejects stale quotes with a bounded reason", async () => {
    const stale = structuredClone(snapshots) as Record<string, any>
    stale.snapshots[longSymbol].latestQuote.t = "2026-08-27T14:28:00.000Z"
    await expectFailure(router({ snapshots: stale }), "OPTION_QUOTE_STALE")
  })

  it("validates input before any network request", async () => {
    const fetchImplementation = router()
    const result = await provider(fetchImplementation).capture({
      ...input,
      shortContractSymbol: longSymbol,
    })
    expect(result).toEqual({
      success: false,
      reasons: ["CAPTURE_INPUT_INVALID"],
    })
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it("propagates cancellation without converting it into a provider failure", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled")
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort(reason)
      throw reason
    })
    await expect(provider(fetchImplementation).capture({
      ...input,
      signal: controller.signal,
    })).rejects.toBe(reason)
  })

  it("rejects unsafe production base URLs", () => {
    expect(() => createAlpacaRiskStateProvider({
      apiKey: "test-key",
      secretKey: "test-secret",
      tradingBaseUrl: "http://paper-api.alpaca.markets",
    })).toThrow("ALPACA_TRADING_BASE_URL")
  })
})
