import { z } from "zod"

import {
  RESEARCH_DECISION_V4_CONTRACT_VERSION,
} from "../contracts/research-decision-v4.js"
import {
  TRADE_INTENT_V4_CONTRACT_VERSION,
  tradeIntentV4Schema,
} from "../contracts/trade-intent-v4.js"
import {
  ALPACA_OPTION_ORDER_CAPABILITY_VERSION,
  alpacaOptionEntryPlanV2Schema,
} from "../options/alpaca-capabilities.js"
import {
  genericReplayExitPolicySchema,
} from "./replay-core.js"
import { runBacktestReplay } from "./replay.js"
import {
  evaluateResearchEligibility,
  newYorkDate,
  newYorkLocalTime,
  type MarketSessionV1,
} from "../scheduling/research-eligibility.js"
import { riskEvaluationInputV2Schema } from "../risk/risk-evaluation-v1.js"
import { canonicalJsonSha256 } from "../shared/canonical-json.js"
import { parseAlpacaOptionSymbol } from "../shared/alpaca-option-identity.js"

export const ALPACA_BAR_PROXY_MANIFEST_VERSION = "1.0.0" as const
export const ALPACA_BAR_PROXY_REPORT_VERSION = "1.0.0" as const
export const ALPACA_BAR_PROXY_PRICING_MODEL =
  "BLACK_SCHOLES_EUROPEAN_PROXY_V1" as const
export const ALPACA_BAR_PROXY_OPTION_SOURCE =
  "ALPACA_ACCOUNT_DEFAULT_OPTION_TRADES_1MIN_PROXY" as const

const MAX_SCENARIOS = 100
const MAX_PROVIDER_PAGE_SIZE = 10_000
const MAX_PROVIDER_PAGES = 100
const ONE_MINUTE_MS = 60_000
const ONE_DAY_MS = 86_400_000
const ENTRY_MAX_AGE_MS = ONE_MINUTE_MS
const STALE_EXIT_MINUTES = 5

const safeInteger = z.number().int().nonnegative().safe()
const positiveSafeInteger = safeInteger.positive()
const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const decimal = z.union([z.number(), z.string()])

const proxyBandNameSchema = z.enum([
  "OPTIMISTIC",
  "BASE",
  "CONSERVATIVE",
])

const proxyBandSchema = z
  .object({
    name: proxyBandNameSchema,
    spreadBps: z.number().int().positive().max(10_000),
    minimumSpreadCents: positiveSafeInteger,
    entrySlippageCentsPerLeg: safeInteger,
    exitSlippageCentsPerLeg: safeInteger,
    commissionCentsPerContract: safeInteger,
  })
  .strict()

const manifestLegSchema = z
  .object({
    symbol: z.string().trim().min(1).max(32),
    intent: z.enum(["BUY_TO_OPEN", "SELL_TO_OPEN"]),
  })
  .strict()

const manifestScenarioSchema = z
  .object({
    scenarioId: z.string().trim().min(1).max(128),
    underlying: z.string().trim().regex(/^[A-Z0-9]{1,6}$/u),
    strategy: z.enum(["BULL_CALL_SPREAD", "BEAR_PUT_SPREAD"]),
    entryAt: timestamp,
    legs: z.array(manifestLegSchema).length(2),
  })
  .strict()
  .superRefine((scenario, refinement) => {
    const plan = alpacaOptionEntryPlanV2Schema.safeParse({
      capabilityVersion: ALPACA_OPTION_ORDER_CAPABILITY_VERSION,
      underlying: scenario.underlying,
      strategy: scenario.strategy,
      legs: scenario.legs.map(({ symbol, intent }) => ({
        contractSymbol: symbol,
        positionIntent: intent,
        ratioQuantity: 1,
      })),
    })
    if (!plan.success) {
      refinement.addIssue({
        code: "custom",
        path: ["legs"],
        message: "Scenario legs do not match the declared debit spread",
      })
    }
  })

export const alpacaBarProxyManifestV1Schema = z
  .object({
    manifestVersion: z.literal(ALPACA_BAR_PROXY_MANIFEST_VERSION),
    initialEquityCents: positiveSafeInteger,
    monitoring: z
      .object({ cadenceMinutes: z.literal(30) })
      .strict(),
    exitPolicy: genericReplayExitPolicySchema,
    marketAssumptions: z
      .object({
        interestRateBps: z.number().int().min(-1_000).max(5_000),
        assumedOpenInterest: safeInteger.max(1_000_000),
        dividendYieldBpsByUnderlying: z.record(
          z.string().regex(/^[A-Z0-9]{1,6}$/u),
          z.number().int().min(0).max(5_000),
        ),
      })
      .strict(),
    accountAssumptions: z
      .object({
        buyingPowerCents: positiveSafeInteger,
        cashCents: safeInteger,
        equityCents: positiveSafeInteger,
      })
      .strict(),
    sensitivityBands: z
      .array(proxyBandSchema)
      .length(3)
      .superRefine((bands, refinement) => {
        const names = new Set(bands.map(({ name }) => name))
        proxyBandNameSchema.options.forEach((name, index) => {
          if (!names.has(name)) {
            refinement.addIssue({
              code: "custom",
              message: `Sensitivity band ${name} is required`,
            })
          }
          if (bands[index]?.name === name) return
          refinement.addIssue({
            code: "custom",
            path: [index, "name"],
            message: `Sensitivity band ${name} must be at index ${index}`,
          })
        })
      }),
    scenarios: z
      .array(manifestScenarioSchema)
      .min(1)
      .max(MAX_SCENARIOS)
      .superRefine((scenarios, refinement) => {
        const identifiers = new Set<string>()
        scenarios.forEach(({ scenarioId }, index) => {
          if (identifiers.has(scenarioId)) {
            refinement.addIssue({
              code: "custom",
              path: [index, "scenarioId"],
              message: "Scenario IDs must be unique",
            })
          }
          identifiers.add(scenarioId)
        })
      }),
  })
  .strict()
  .superRefine((manifest, refinement) => {
    if (manifest.exitPolicy.maxHoldingSessions <= 20) return
    refinement.addIssue({
      code: "custom",
      path: ["exitPolicy", "maxHoldingSessions"],
      message: "Bar-proxy holding periods cannot exceed 20 sessions",
    })
  })

export type AlpacaBarProxyManifestV1 = Readonly<
  z.infer<typeof alpacaBarProxyManifestV1Schema>
>

const providerBarSchema = z
  .object({
    t: z.string(),
    c: decimal,
    v: decimal,
  })
  .passthrough()

const optionBarsResponseSchema = z
  .object({
    bars: z.record(
      z.string(),
      z.array(providerBarSchema).max(MAX_PROVIDER_PAGE_SIZE),
    ),
    next_page_token: z.string().min(1).nullable().optional(),
  })
  .passthrough()

const stockBarsResponseSchema = z
  .object({
    bars: z.array(providerBarSchema).max(MAX_PROVIDER_PAGE_SIZE),
    next_page_token: z.string().min(1).nullable().optional(),
  })
  .passthrough()

const calendarDaySchema = z
  .object({
    date: z.iso.date(),
    open: z.string().min(1).max(64),
    close: z.string().min(1).max(64),
  })
  .passthrough()

const calendarResponseSchema = z.array(calendarDaySchema).max(10_000)

type ProviderBar = z.infer<typeof providerBarSchema>
type ManifestScenario = z.infer<typeof manifestScenarioSchema>
type ProxyBand = z.infer<typeof proxyBandSchema>

type NormalizedMinuteBar = Readonly<{
  start: string
  end: string
  startMs: number
  endMs: number
  close: number
  volume: number
}>

type NormalizedDailyClose = Readonly<{
  sessionDate: string
  closeMicros: number
}>

export type AlpacaBarProxyFailureCode =
  | "MANIFEST_INVALID"
  | "CALENDAR_REQUEST_FAILED"
  | "CALENDAR_RESPONSE_INVALID"
  | "SESSION_MISSING"
  | "HOLDING_SESSIONS_INCOMPLETE"
  | "HISTORICAL_HORIZON_INCOMPLETE"
  | "OPTION_BARS_REQUEST_FAILED"
  | "OPTION_BARS_RESPONSE_INVALID"
  | "STOCK_BARS_REQUEST_FAILED"
  | "STOCK_BARS_RESPONSE_INVALID"
  | "PAGINATION_LIMIT_EXCEEDED"
  | "SCENARIO_ENTRY_INELIGIBLE"
  | "DIVIDEND_ASSUMPTION_MISSING"
  | "ENTRY_OPTION_BAR_MISSING"
  | "ENTRY_OPTION_BAR_STALE"
  | "ENTRY_UNDERLYING_BAR_MISSING"
  | "ENTRY_UNDERLYING_BAR_STALE"
  | "SYNTHETIC_QUOTE_INVALID"
  | "SYNTHETIC_PREMIUM_INVALID"
  | "OPTION_PRICING_PROXY_INVALID"
  | "REPLAY_INPUT_INVALID"

export class AlpacaBarProxyError extends Error {
  constructor(readonly code: AlpacaBarProxyFailureCode) {
    super(code)
    this.name = "AlpacaBarProxyError"
  }
}

function fail(code: AlpacaBarProxyFailureCode): never {
  throw new AlpacaBarProxyError(code)
}

const providerNumber = (value: number | string) => {
  const number = typeof value === "number" ? value : Number(value)
  return Number.isFinite(number) ? number : undefined
}

const normalizeMinuteBars = (
  bars: readonly ProviderBar[],
  failure: AlpacaBarProxyFailureCode,
): readonly NormalizedMinuteBar[] => {
  const normalized = new Map<number, NormalizedMinuteBar>()
  for (const bar of bars) {
    const startMs = Date.parse(bar.t)
    const close = providerNumber(bar.c)
    const volume = providerNumber(bar.v)
    if (
      !Number.isFinite(startMs) ||
      startMs % ONE_MINUTE_MS !== 0 ||
      close === undefined ||
      close <= 0 ||
      volume === undefined ||
      !Number.isSafeInteger(volume) ||
      volume < 0
    ) fail(failure)
    const candidate = {
      start: new Date(startMs).toISOString(),
      end: new Date(startMs + ONE_MINUTE_MS).toISOString(),
      startMs,
      endMs: startMs + ONE_MINUTE_MS,
      close,
      volume,
    }
    const previous = normalized.get(startMs)
    if (
      previous !== undefined &&
      (previous.close !== candidate.close || previous.volume !== candidate.volume)
    ) fail(failure)
    normalized.set(startMs, candidate)
  }
  return [...normalized.values()].sort((left, right) => left.startMs - right.startMs)
}

const normalizeDailyCloses = (
  bars: readonly ProviderBar[],
): readonly NormalizedDailyClose[] => {
  const closes = new Map<string, number>()
  for (const bar of bars) {
    const timestampMs = Date.parse(bar.t)
    const close = providerNumber(bar.c)
    if (!Number.isFinite(timestampMs) || close === undefined || close <= 0) {
      fail("STOCK_BARS_RESPONSE_INVALID")
    }
    const closeMicros = Math.round(close * 1_000_000)
    if (!Number.isSafeInteger(closeMicros) || closeMicros <= 0) {
      fail("STOCK_BARS_RESPONSE_INVALID")
    }
    const date = newYorkDate(new Date(timestampMs))
    const previous = closes.get(date)
    if (previous !== undefined && previous !== closeMicros) {
      fail("STOCK_BARS_RESPONSE_INVALID")
    }
    closes.set(date, closeMicros)
  }
  return [...closes.entries()]
    .map(([sessionDate, closeMicros]) => ({ sessionDate, closeMicros }))
    .sort((left, right) => left.sessionDate.localeCompare(right.sessionDate))
}

const parseSessionTimestamp = (date: string, value: string) => {
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
    return newYorkLocalTime(date, value).toISOString()
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) fail("CALENDAR_RESPONSE_INVALID")
  return new Date(milliseconds).toISOString()
}

const shiftDate = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(value.getTime())) fail("MANIFEST_INVALID")
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

const completedBarAt = (
  bars: readonly NormalizedMinuteBar[],
  decisionMs: number,
  session: MarketSessionV1,
) => {
  const open = Date.parse(session.open)
  return bars.findLast(({ startMs, endMs }) =>
    startMs >= open && endMs <= decisionMs
  )
}

const normalCdf = (value: number) => {
  const absolute = Math.abs(value)
  const t = 1 / (1 + 0.2316419 * absolute)
  const density = Math.exp(-(absolute * absolute) / 2) / Math.sqrt(2 * Math.PI)
  const polynomial = t * (
    0.319381530 + t * (
      -0.356563782 + t * (
        1.781477937 + t * (-1.821255978 + t * 1.330274429)
      )
    )
  )
  const positive = 1 - density * polynomial
  return value >= 0 ? positive : 1 - positive
}

const normalDensity = (value: number) =>
  Math.exp(-(value * value) / 2) / Math.sqrt(2 * Math.PI)

type PricingInputs = Readonly<{
  optionType: "C" | "P"
  optionPrice: number
  underlyingPrice: number
  strikePrice: number
  yearsToExpiration: number
  interestRate: number
  dividendYield: number
}>

const blackScholes = (inputs: PricingInputs, volatility: number) => {
  const {
    optionType,
    underlyingPrice: spot,
    strikePrice: strike,
    yearsToExpiration: time,
    interestRate: rate,
    dividendYield: dividend,
  } = inputs
  const squareRootTime = Math.sqrt(time)
  const d1 = (
    Math.log(spot / strike) +
    (rate - dividend + volatility * volatility / 2) * time
  ) / (volatility * squareRootTime)
  const d2 = d1 - volatility * squareRootTime
  const discountedSpot = spot * Math.exp(-dividend * time)
  const discountedStrike = strike * Math.exp(-rate * time)
  const price = optionType === "C"
    ? discountedSpot * normalCdf(d1) - discountedStrike * normalCdf(d2)
    : discountedStrike * normalCdf(-d2) - discountedSpot * normalCdf(-d1)
  return { price, d1, d2, discountedSpot, discountedStrike }
}

/** Derives deterministic European-model metrics from one historical trade proxy. */
export const deriveOptionPricingProxyV1 = (inputs: PricingInputs) => {
  const {
    optionType,
    optionPrice,
    underlyingPrice: spot,
    strikePrice: strike,
    yearsToExpiration: time,
    interestRate: rate,
    dividendYield: dividend,
  } = inputs
  if (
    ![optionPrice, spot, strike, time, rate, dividend].every(Number.isFinite) ||
    optionPrice <= 0 ||
    spot <= 0 ||
    strike <= 0 ||
    time <= 0
  ) return undefined
  const discountedSpot = spot * Math.exp(-dividend * time)
  const discountedStrike = strike * Math.exp(-rate * time)
  const lower = optionType === "C"
    ? Math.max(0, discountedSpot - discountedStrike)
    : Math.max(0, discountedStrike - discountedSpot)
  const upper = optionType === "C" ? discountedSpot : discountedStrike
  if (optionPrice <= lower || optionPrice >= upper) return undefined

  let low = 0.0001
  let high = 5
  if (blackScholes(inputs, high).price < optionPrice) return undefined
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const middle = (low + high) / 2
    if (blackScholes(inputs, middle).price < optionPrice) low = middle
    else high = middle
  }
  const volatility = (low + high) / 2
  const priced = blackScholes(inputs, volatility)
  if (Math.abs(priced.price - optionPrice) > 0.0001) return undefined
  const density = normalDensity(priced.d1)
  const squareRootTime = Math.sqrt(time)
  const discountDividend = Math.exp(-dividend * time)
  const discountRate = Math.exp(-rate * time)
  const delta = optionType === "C"
    ? discountDividend * normalCdf(priced.d1)
    : discountDividend * (normalCdf(priced.d1) - 1)
  const gamma = discountDividend * density / (spot * volatility * squareRootTime)
  const vega = spot * discountDividend * density * squareRootTime / 100
  const commonTheta = -spot * discountDividend * density * volatility /
    (2 * squareRootTime)
  const annualTheta = optionType === "C"
    ? commonTheta - rate * strike * discountRate * normalCdf(priced.d2) +
      dividend * spot * discountDividend * normalCdf(priced.d1)
    : commonTheta + rate * strike * discountRate * normalCdf(-priced.d2) -
      dividend * spot * discountDividend * normalCdf(-priced.d1)
  const metrics = {
    impliedVolatility: volatility,
    delta,
    gamma,
    theta: annualTheta / 365,
    vega,
  }
  return Object.values(metrics).every(Number.isFinite) ? metrics : undefined
}

const proxyQuote = (
  bar: NormalizedMinuteBar,
  band: ProxyBand,
  requirePositiveBid: boolean,
) => {
  const referenceCents = Math.round(bar.close * 100)
  if (!Number.isSafeInteger(referenceCents) || referenceCents <= 0) return undefined
  const halfSpread = Math.max(
    band.minimumSpreadCents,
    Math.ceil(referenceCents * band.spreadBps / 20_000),
  )
  const bid = referenceCents - halfSpread
  const ask = referenceCents + halfSpread
  if (
    !Number.isSafeInteger(bid) ||
    !Number.isSafeInteger(ask) ||
    ask <= 0 ||
    ask <= bid ||
    (requirePositiveBid ? bid <= 0 : bid < 0)
  ) return undefined
  return { bidCentsPerShare: bid, askCentsPerShare: ask }
}

type ScenarioData = Readonly<{
  scenario: ManifestScenario
  entrySessionIndex: number
  holdingSessions: readonly MarketSessionV1[]
  optionBars: Readonly<Record<string, readonly NormalizedMinuteBar[]>>
  underlyingMinuteBars: readonly NormalizedMinuteBar[]
  dailyCloses: readonly NormalizedDailyClose[]
  entryOptionBars: Readonly<Record<string, NormalizedMinuteBar>>
  entryUnderlyingBar: NormalizedMinuteBar
  evidence: Readonly<Record<string, unknown>>
}>

export type RunAlpacaBarProxyBacktestOptions = Readonly<{
  apiKey: string
  secretKey: string
  dataBaseUrl?: string
  tradingBaseUrl?: string
  fetch?: typeof fetch
  now?: () => Date
  signal?: AbortSignal
}>

const normalizeBaseUrl = (
  value: string,
  expectedOrigin: string,
  setting: string,
  allowCustomHost: boolean,
) => {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      (!allowCustomHost && url.origin !== expectedOrigin)
    ) throw new Error("invalid origin")
    return url.origin
  } catch {
    throw new Error(`${setting} must be a credential-free Alpaca HTTPS URL`)
  }
}

const directionFor = (strategy: ManifestScenario["strategy"]) =>
  strategy === "BULL_CALL_SPREAD" ? "BULLISH" as const : "BEARISH" as const

const expirationFor = (scenario: ManifestScenario) => {
  const identities = scenario.legs.map(({ symbol }) => parseAlpacaOptionSymbol(symbol))
  if (identities.some((identity) => !identity.success)) fail("MANIFEST_INVALID")
  return identities[0]!.success ? identities[0]!.identity.expiration : fail("MANIFEST_INVALID")
}

const classifySensitivity = (
  bands: readonly Readonly<{
    coverage: Readonly<{ requested: number; generated: number }>
    replay: unknown | null
  }>[],
) => {
  const totals = bands.map(({ coverage, replay }) => {
    if (coverage.generated !== coverage.requested || replay === null) return undefined
    const aggregate = (replay as {
      aggregate?: { status?: string; totalPnlCents?: number }
    }).aggregate
    return aggregate?.status === "COMPLETE" &&
        typeof aggregate.totalPnlCents === "number"
      ? aggregate.totalPnlCents
      : undefined
  })
  if (totals.some((value) => value === undefined)) return "INCOMPLETE" as const
  const profitable = totals.map((value) => value! > 0)
  if (profitable.every(Boolean)) return "ROBUST_ACROSS_BANDS" as const
  if (profitable.every((value) => !value)) return "NOT_SUPPORTED" as const
  if (profitable[0] && !profitable[1] && !profitable[2]) return "FRAGILE" as const
  return "SENSITIVE" as const
}

/** Fetches historical bars once, projects explicit proxies, and delegates to V8 replay. */
export async function runAlpacaBarProxyBacktest(
  input: unknown,
  options: RunAlpacaBarProxyBacktestOptions,
) {
  const parsedManifest = alpacaBarProxyManifestV1Schema.safeParse(input)
  if (!parsedManifest.success) fail("MANIFEST_INVALID")
  const manifest = parsedManifest.data
  const request = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
  const generatedAt = now()
  if (!Number.isFinite(generatedAt.getTime())) fail("MANIFEST_INVALID")
  const signal = options.signal ?? new AbortController().signal
  const allowCustomHost = options.fetch !== undefined
  const dataBaseUrl = normalizeBaseUrl(
    options.dataBaseUrl ?? "https://data.alpaca.markets",
    "https://data.alpaca.markets",
    "ALPACA_MARKET_DATA_BASE_URL",
    allowCustomHost,
  )
  const tradingBaseUrl = normalizeBaseUrl(
    options.tradingBaseUrl ?? "https://paper-api.alpaca.markets",
    "https://paper-api.alpaca.markets",
    "ALPACA_TRADING_BASE_URL",
    allowCustomHost,
  )
  const headers = {
    "APCA-API-KEY-ID": options.apiKey,
    "APCA-API-SECRET-KEY": options.secretKey,
  }

  const getJson = async (
    url: URL,
    requestFailure: AlpacaBarProxyFailureCode,
    responseFailure: AlpacaBarProxyFailureCode,
  ) => {
    let response: Response
    try {
      response = await request(url, {
        method: "GET",
        redirect: "error",
        headers,
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      fail(requestFailure)
    }
    if (!response.ok) fail(requestFailure)
    try {
      return await response.json() as unknown
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      fail(responseFailure)
    }
  }

  const fetchCalendar = async (start: string, end: string) => {
    const url = new URL("/v2/calendar", tradingBaseUrl)
    url.searchParams.set("start", start)
    url.searchParams.set("end", end)
    const raw = await getJson(
      url,
      "CALENDAR_REQUEST_FAILED",
      "CALENDAR_RESPONSE_INVALID",
    )
    const parsed = calendarResponseSchema.safeParse(raw)
    if (!parsed.success) fail("CALENDAR_RESPONSE_INVALID")
    const sessions = parsed.data.map((day) => ({
      date: day.date,
      open: parseSessionTimestamp(day.date, day.open),
      close: parseSessionTimestamp(day.date, day.close),
    })).sort((left, right) => left.date.localeCompare(right.date))
    sessions.forEach((session, index) => {
      if (
        Date.parse(session.open) >= Date.parse(session.close) ||
        (index > 0 && session.date <= sessions[index - 1]!.date)
      ) fail("CALENDAR_RESPONSE_INVALID")
    })
    return sessions
  }

  const fetchOptionBars = async (
    symbols: readonly string[],
    start: string,
    end: string,
  ) => {
    const retained = Object.fromEntries(symbols.map((symbol) => [symbol, [] as ProviderBar[]]))
    let pageToken: string | undefined
    const seenTokens = new Set<string>()
    for (let page = 0; page < MAX_PROVIDER_PAGES; page += 1) {
      const url = new URL("/v1beta1/options/bars", dataBaseUrl)
      url.searchParams.set("symbols", symbols.join(","))
      url.searchParams.set("timeframe", "1Min")
      url.searchParams.set("start", start)
      url.searchParams.set("end", end)
      url.searchParams.set("sort", "asc")
      url.searchParams.set("limit", String(MAX_PROVIDER_PAGE_SIZE))
      if (pageToken !== undefined) url.searchParams.set("page_token", pageToken)
      const raw = await getJson(
        url,
        "OPTION_BARS_REQUEST_FAILED",
        "OPTION_BARS_RESPONSE_INVALID",
      )
      const parsed = optionBarsResponseSchema.safeParse(raw)
      if (!parsed.success) fail("OPTION_BARS_RESPONSE_INVALID")
      for (const [symbol, bars] of Object.entries(parsed.data.bars)) {
        if (!Object.hasOwn(retained, symbol)) fail("OPTION_BARS_RESPONSE_INVALID")
        retained[symbol]!.push(...bars)
      }
      const next = parsed.data.next_page_token ?? undefined
      if (next === undefined) return retained
      if (seenTokens.has(next)) fail("OPTION_BARS_RESPONSE_INVALID")
      seenTokens.add(next)
      pageToken = next
    }
    fail("PAGINATION_LIMIT_EXCEEDED")
  }

  const fetchStockBars = async (
    symbol: string,
    timeframe: "1Min" | "1Day",
    start: string,
    end: string,
  ) => {
    const retained: ProviderBar[] = []
    let pageToken: string | undefined
    const seenTokens = new Set<string>()
    for (let page = 0; page < MAX_PROVIDER_PAGES; page += 1) {
      const url = new URL(`/v2/stocks/${symbol}/bars`, dataBaseUrl)
      url.searchParams.set("timeframe", timeframe)
      url.searchParams.set("start", start)
      url.searchParams.set("end", end)
      url.searchParams.set("feed", "iex")
      url.searchParams.set("adjustment", "raw")
      url.searchParams.set("sort", "asc")
      url.searchParams.set("limit", String(MAX_PROVIDER_PAGE_SIZE))
      if (pageToken !== undefined) url.searchParams.set("page_token", pageToken)
      const raw = await getJson(
        url,
        "STOCK_BARS_REQUEST_FAILED",
        "STOCK_BARS_RESPONSE_INVALID",
      )
      const parsed = stockBarsResponseSchema.safeParse(raw)
      if (!parsed.success) fail("STOCK_BARS_RESPONSE_INVALID")
      retained.push(...parsed.data.bars)
      const next = parsed.data.next_page_token ?? undefined
      if (next === undefined) return retained
      if (seenTokens.has(next)) fail("STOCK_BARS_RESPONSE_INVALID")
      seenTokens.add(next)
      pageToken = next
    }
    fail("PAGINATION_LIMIT_EXCEEDED")
  }

  const entryDates = manifest.scenarios.map(({ entryAt }) =>
    newYorkDate(new Date(entryAt))
  )
  const firstDate = [...entryDates].sort()[0]!
  const lastDate = [...entryDates].sort().at(-1)!
  const calendarStart = shiftDate(firstDate, -60)
  const calendarEnd = shiftDate(
    lastDate,
    manifest.exitPolicy.maxHoldingSessions * 4 + 14,
  )
  const sessions = await fetchCalendar(calendarStart, calendarEnd)
  const replaySessions = sessions.map(({ date, open, close }) => ({ date, open, close }))

  const staticFailures: Array<Readonly<{
    scenarioId: string
    code: AlpacaBarProxyFailureCode
  }>> = []
  const scenarioData: ScenarioData[] = []

  for (const scenario of manifest.scenarios) {
    try {
      const entryDate = newYorkDate(new Date(scenario.entryAt))
      const entrySessionIndex = sessions.findIndex(({ date }) => date === entryDate)
      if (entrySessionIndex < 0) fail("SESSION_MISSING")
      const entrySession = sessions[entrySessionIndex]!
      const holdingSessions = sessions.slice(
        entrySessionIndex,
        entrySessionIndex + manifest.exitPolicy.maxHoldingSessions,
      )
      if (holdingSessions.length !== manifest.exitPolicy.maxHoldingSessions) {
        fail("HOLDING_SESSIONS_INCOMPLETE")
      }
      if (
        Date.parse(holdingSessions.at(-1)!.close) >
          generatedAt.getTime() - 15 * ONE_MINUTE_MS
      ) fail("HISTORICAL_HORIZON_INCOMPLETE")
      const previousSessionDates = sessions
        .slice(Math.max(0, entrySessionIndex - 16), entrySessionIndex)
        .map(({ date }) => date)
      const eligibility = evaluateResearchEligibility({
        evaluatedAt: new Date(scenario.entryAt),
        session: { ...entrySession, previousSessionDates },
      })
      if (!eligibility.tradeIntentEligible) fail("SCENARIO_ENTRY_INELIGIBLE")
      if (
        manifest.marketAssumptions.dividendYieldBpsByUnderlying[
          scenario.underlying
        ] === undefined
      ) fail("DIVIDEND_ASSUMPTION_MISSING")
      const optionRaw = await fetchOptionBars(
        scenario.legs.map(({ symbol }) => symbol),
        entrySession.open,
        holdingSessions.at(-1)!.close,
      )
      const optionBars = Object.fromEntries(scenario.legs.map(({ symbol }) => [
        symbol,
        normalizeMinuteBars(
          optionRaw[symbol] ?? [],
          "OPTION_BARS_RESPONSE_INVALID",
        ),
      ]))
      const stockMinuteRaw = await fetchStockBars(
        scenario.underlying,
        "1Min",
        entrySession.open,
        scenario.entryAt,
      )
      const stockDailyRaw = await fetchStockBars(
        scenario.underlying,
        "1Day",
        sessions[0]!.open,
        holdingSessions.at(-1)!.close,
      )
      const underlyingMinuteBars = normalizeMinuteBars(
        stockMinuteRaw,
        "STOCK_BARS_RESPONSE_INVALID",
      )
      const dailyCloses = normalizeDailyCloses(stockDailyRaw)
      const entryMs = Date.parse(scenario.entryAt)
      const entryOptionBars = Object.fromEntries(scenario.legs.map(({ symbol }) => {
        const bar = completedBarAt(optionBars[symbol] ?? [], entryMs, entrySession)
        if (bar === undefined) fail("ENTRY_OPTION_BAR_MISSING")
        if (entryMs - bar.endMs > ENTRY_MAX_AGE_MS) fail("ENTRY_OPTION_BAR_STALE")
        return [symbol, bar]
      }))
      const entryUnderlyingBar = completedBarAt(
        underlyingMinuteBars,
        entryMs,
        entrySession,
      )
      if (entryUnderlyingBar === undefined) fail("ENTRY_UNDERLYING_BAR_MISSING")
      if (entryMs - entryUnderlyingBar.endMs > ENTRY_MAX_AGE_MS) {
        fail("ENTRY_UNDERLYING_BAR_STALE")
      }
      const normalizedEvidence = {
        optionBars,
        underlyingMinuteBars,
        dailyCloses,
      }
      scenarioData.push({
        scenario,
        entrySessionIndex,
        holdingSessions,
        optionBars,
        underlyingMinuteBars,
        dailyCloses,
        entryOptionBars,
        entryUnderlyingBar,
        evidence: {
          scenarioId: scenario.scenarioId,
          optionBarCounts: Object.fromEntries(scenario.legs.map(({ symbol }) => [
            symbol,
            optionBars[symbol]?.length ?? 0,
          ])),
          underlyingMinuteBarCount: underlyingMinuteBars.length,
          underlyingDailyCloseCount: dailyCloses.length,
          entryOptionBarEnds: Object.fromEntries(scenario.legs.map(({ symbol }) => [
            symbol,
            entryOptionBars[symbol]!.end,
          ])),
          entryUnderlyingBarEnd: entryUnderlyingBar.end,
          normalizedDataSha256: canonicalJsonSha256(normalizedEvidence),
        },
      })
    } catch (error) {
      if (!(error instanceof AlpacaBarProxyError)) throw error
      staticFailures.push({ scenarioId: scenario.scenarioId, code: error.code })
    }
  }

  const bands = manifest.sensitivityBands.map((band) => {
    const scenarioFailures = [...staticFailures]
    const generatedScenarios: unknown[] = []
    for (const data of scenarioData) {
      const { scenario } = data
      try {
        const entryMs = Date.parse(scenario.entryAt)
        const quotes = scenario.legs.map(({ symbol }) => {
          const quote = proxyQuote(data.entryOptionBars[symbol]!, band, true)
          if (quote === undefined) fail("SYNTHETIC_QUOTE_INVALID")
          return {
            contractSymbol: symbol,
            feed: "INDICATIVE" as const,
            ...quote,
            providerTimestamp: data.entryOptionBars[symbol]!.end,
          }
        })
        const signedPremium = scenario.legs.reduce((total, leg, index) =>
          total + BigInt(
            leg.intent === "BUY_TO_OPEN"
              ? quotes[index]!.askCentsPerShare
              : -quotes[index]!.bidCentsPerShare,
          ), 0n)
        if (signedPremium <= 0n || signedPremium > BigInt(Number.MAX_SAFE_INTEGER)) {
          fail("SYNTHETIC_PREMIUM_INVALID")
        }
        const intentResult = tradeIntentV4Schema.safeParse({
          contractVersion: TRADE_INTENT_V4_CONTRACT_VERSION,
          decisionContractVersion: RESEARCH_DECISION_V4_CONTRACT_VERSION,
          underlying: scenario.underlying,
          direction: directionFor(scenario.strategy),
          strategy: scenario.strategy,
          quoteSnapshotRef: `bar-proxy-${canonicalJsonSha256({
            scenarioId: scenario.scenarioId,
            band: band.name,
          }).slice(0, 32)}`,
          evaluatedAt: scenario.entryAt,
          legs: scenario.legs.map((leg, index) => ({
            contractSymbol: leg.symbol,
            positionIntent: leg.intent,
            ratioQuantity: 1,
            quote: quotes[index],
          })),
          premiumEffect: "DEBIT",
          entryLimitCentsPerStrategyUnit: Number(signedPremium),
        })
        if (!intentResult.success) fail("SYNTHETIC_PREMIUM_INVALID")
        const expiration = expirationFor(scenario)
        const expirationAt = newYorkLocalTime(expiration, "16:00").getTime()
        const yearsToExpiration = (expirationAt - entryMs) / (365 * ONE_DAY_MS)
        const interestRate = manifest.marketAssumptions.interestRateBps / 10_000
        const dividendYield = manifest.marketAssumptions
          .dividendYieldBpsByUnderlying[scenario.underlying]! / 10_000
        const contractMetrics = scenario.legs.map((leg) => {
          const identity = parseAlpacaOptionSymbol(leg.symbol)
          if (!identity.success) fail("MANIFEST_INVALID")
          const metrics = deriveOptionPricingProxyV1({
            optionType: identity.identity.optionType,
            optionPrice: data.entryOptionBars[leg.symbol]!.close,
            underlyingPrice: data.entryUnderlyingBar.close,
            strikePrice: identity.identity.strikeThousandthsPerShare / 1_000,
            yearsToExpiration,
            interestRate,
            dividendYield,
          })
          if (metrics === undefined) fail("OPTION_PRICING_PROXY_INVALID")
          const volume = (data.optionBars[leg.symbol] ?? [])
            .filter(({ startMs, endMs }) =>
              startMs >= Date.parse(data.holdingSessions[0]!.open) &&
              endMs <= entryMs
            )
            .reduce((total, bar) => total + bar.volume, 0)
          if (!Number.isSafeInteger(volume)) fail("OPTION_BARS_RESPONSE_INVALID")
          return {
            contractSymbol: leg.symbol,
            positionIntent: leg.intent,
            ratioQuantity: 1,
            active: true,
            tradable: true,
            exerciseStyle: "AMERICAN" as const,
            multiplier: 100,
            ...metrics,
            volume,
            volumeDate: data.holdingSessions[0]!.date,
            openInterest: manifest.marketAssumptions.assumedOpenInterest,
            openInterestDate: sessions[data.entrySessionIndex - 1]?.date ??
              data.holdingSessions[0]!.date,
          }
        })
        const eligibility = evaluateResearchEligibility({
          evaluatedAt: new Date(scenario.entryAt),
          session: {
            ...data.holdingSessions[0]!,
            previousSessionDates: sessions
              .slice(Math.max(0, data.entrySessionIndex - 16), data.entrySessionIndex)
              .map(({ date }) => date),
          },
        })
        const riskInputResult = riskEvaluationInputV2Schema.safeParse({
          intent: intentResult.data,
          context: {
            provenance: "APPLICATION_VERIFIED",
            eligibility,
            account: {
              snapshotVersion: "2.0.0",
              observedAt: scenario.entryAt,
              status: "ACTIVE",
              tradingRestricted: false,
              optionsApprovedLevel: 3,
              optionsTradingLevel: 3,
              multilegOptionsApproved: true,
              buyingPowerCents: manifest.accountAssumptions.buyingPowerCents,
              cashCents: manifest.accountAssumptions.cashCents,
              equityCents: manifest.accountAssumptions.equityCents,
              lastEquityCents: manifest.accountAssumptions.equityCents,
            },
            candidateCollateral: {
              underlying: scenario.underlying,
              longUnderlyingShares: 0,
              cashAvailableCents: Math.min(
                manifest.accountAssumptions.cashCents,
                manifest.accountAssumptions.buyingPowerCents,
              ),
              requiredLongSharesPerUnit: 0,
              requiredCashCentsPerUnit: 0,
              maxUnitsFromShares: null,
              maxUnitsFromCash: null,
            },
            portfolio: {
              observedAt: scenario.entryAt,
              consistent: true,
              openStrategyPositionCount: 0,
              pendingEntryCount: 0,
              entriesSubmittedToday: 0,
              dailyBreakerActive: false,
              competitionBreakerActive: false,
            },
            contracts: {
              snapshotVersion: "2.0.0",
              slotStartedAt: eligibility.tradeIntentWindow?.slotStartedAt,
              observedAt: scenario.entryAt,
              legs: contractMetrics,
            },
          },
        })
        if (!riskInputResult.success) fail("REPLAY_INPUT_INVALID")
        const closeByDate = new Map(
          data.dailyCloses.map(({ sessionDate, closeMicros }) => [
            sessionDate,
            closeMicros,
          ]),
        )
        const monitorCycles: unknown[] = []
        data.holdingSessions.forEach((session, holdingIndex) => {
          const open = Date.parse(session.open)
          const close = Date.parse(session.close)
          for (
            let decisionMs = open;
            decisionMs < close;
            decisionMs += manifest.monitoring.cadenceMinutes * ONE_MINUTE_MS
          ) {
            if (decisionMs <= entryMs) continue
            const bars = scenario.legs.map(({ symbol }) =>
              completedBarAt(data.optionBars[symbol] ?? [], decisionMs, session)
            )
            const staleMinutes = bars.some((bar) => bar === undefined)
              ? 1_440
              : Math.max(...bars.map((bar) =>
                Math.floor((decisionMs - bar!.endMs) / ONE_MINUTE_MS)
              ))
            let closePremiumCentsPerStrategyUnit: number | undefined
            if (staleMinutes < STALE_EXIT_MINUTES) {
              const closeQuotes = bars.map((bar) => proxyQuote(bar!, band, false))
              if (closeQuotes.every((quote) => quote !== undefined)) {
                const closeValue = scenario.legs.reduce((total, leg, index) =>
                  total + BigInt(
                    leg.intent === "BUY_TO_OPEN"
                      ? closeQuotes[index]!.bidCentsPerShare
                      : -closeQuotes[index]!.askCentsPerShare,
                  ), 0n)
                if (closeValue >= 0n && closeValue <= BigInt(Number.MAX_SAFE_INTEGER)) {
                  closePremiumCentsPerStrategyUnit = Number(closeValue)
                }
              }
            }
            const globalSessionIndex = data.entrySessionIndex + holdingIndex
            const trendDates = sessions
              .slice(0, globalSessionIndex)
              .slice(-20)
              .map(({ date }) => date)
            const trendCloses = trendDates.map((date) => closeByDate.get(date))
            const trendComplete = trendCloses.length === 20 &&
              trendCloses.every((value) => value !== undefined)
            const trendTotal = trendComplete
              ? trendCloses.reduce((total, value) => total + BigInt(value!), 0n)
              : undefined
            monitorCycles.push({
              decidedAt: new Date(decisionMs).toISOString(),
              marketOpen: true,
              lateFill: false,
              dte: (Date.parse(`${expiration}T00:00:00.000Z`) -
                Date.parse(`${session.date}T00:00:00.000Z`)) / ONE_DAY_MS,
              minutesToClose: Math.max(0, Math.floor((close - decisionMs) / ONE_MINUTE_MS)),
              staleMinutes,
              ...(closePremiumCentsPerStrategyUnit === undefined
                ? {}
                : { closePremiumCentsPerStrategyUnit }),
              ...(trendTotal === undefined
                ? {}
                : {
                    completedDailyCloseMicros: trendCloses.at(-1),
                    sma20Micros: Number((trendTotal + 10n) / 20n),
                  }),
              holdingSessionIndex: holdingIndex + 1,
            })
          }
        })
        generatedScenarios.push({
          scenarioId: scenario.scenarioId,
          riskInput: riskInputResult.data,
          dailyCloses: data.dailyCloses,
          monitorCycles,
        })
      } catch (error) {
        if (!(error instanceof AlpacaBarProxyError)) throw error
        scenarioFailures.push({ scenarioId: scenario.scenarioId, code: error.code })
      }
    }
    const replayInput = generatedScenarios.length === 0
      ? null
      : {
          replayVersion: "8.0.0" as const,
          initialEquityCents: manifest.initialEquityCents,
          execution: {
            entrySlippageCentsPerLeg: band.entrySlippageCentsPerLeg,
            exitSlippageCentsPerLeg: band.exitSlippageCentsPerLeg,
            commissionCentsPerContract: band.commissionCentsPerContract,
          },
          exitPolicy: manifest.exitPolicy,
          sessions: replaySessions,
          scenarios: generatedScenarios,
        }
    let replay: unknown | null = null
    if (replayInput !== null) {
      try {
        replay = runBacktestReplay(replayInput)
      } catch (error) {
        if (!(error instanceof z.ZodError)) throw error
        for (const scenario of manifest.scenarios) {
          if (scenarioFailures.some(({ scenarioId }) => scenarioId === scenario.scenarioId)) {
            continue
          }
          scenarioFailures.push({
            scenarioId: scenario.scenarioId,
            code: "REPLAY_INPUT_INVALID",
          })
        }
      }
    }
    return {
      name: band.name,
      assumptions: band,
      coverage: {
        requested: manifest.scenarios.length,
        generated: replay === null ? 0 : generatedScenarios.length,
        rejected: scenarioFailures.length,
      },
      scenarioFailures,
      replayInput,
      replay,
    }
  })

  return {
    reportVersion: ALPACA_BAR_PROXY_REPORT_VERSION,
    manifestSha256: canonicalJsonSha256(manifest),
    generatedAt: generatedAt.toISOString(),
    manifest,
    proxyAssumptions: {
      optionSource: ALPACA_BAR_PROXY_OPTION_SOURCE,
      optionFeed: "ACCOUNT_DEFAULT_EXPECTED_INDICATIVE" as const,
      stockFeed: "iex" as const,
      timeframe: "1Min" as const,
      pricingModel: ALPACA_BAR_PROXY_PRICING_MODEL,
      contractStyleMismatch: "AMERICAN_CONTRACTS_EUROPEAN_MODEL" as const,
      riskInterpretation: "CONDITIONAL_ON_PROXY_ASSUMPTIONS" as const,
      barAvailability: "BAR_END_NOT_AFTER_DECISION" as const,
      staleExitPricing: "UNPRICED_AT_FIVE_MINUTES" as const,
      quoteReference: "LAST_COMPLETED_OPTION_TRADE_BAR_CLOSE" as const,
      quoteRounding: "REFERENCE_NEAREST_CENT_SPREAD_OUTWARD" as const,
      volume: "CUMULATIVE_COMPLETED_ENTRY_SESSION_BARS" as const,
      contractEligibility: {
        active: true,
        tradable: true,
        exerciseStyle: "AMERICAN" as const,
        multiplier: 100 as const,
      },
      portfolio: "EMPTY_STARTING_PORTFOLIO" as const,
      strategyUnitsPerScenario: 1 as const,
    },
    scenarioEvidence: scenarioData.map(({ evidence }) => evidence),
    staticFailures,
    bands,
    sensitivityClassification: classifySensitivity(bands),
  }
}
