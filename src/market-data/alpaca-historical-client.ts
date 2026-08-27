import { z } from "zod"

import type {
  BacktestDatasetRecordV1,
  MarketSessionRecordV1,
  OptionBarRecordV1,
  OptionContractRecordV1,
  OptionTradeRecordV1,
  UnderlyingBarRecordV1,
} from "../backtest/dataset-v1.js"
import { newYorkLocalTime } from "../scheduling/research-eligibility.js"

const DEFAULT_DATA_URL = "https://data.alpaca.markets"
const DEFAULT_TRADING_URL = "https://paper-api.alpaca.markets"
const MAX_PAGE_TOKEN_LENGTH = 4_096

const pageEnvelopeSchema = z
  .object({ next_page_token: z.string().max(MAX_PAGE_TOKEN_LENGTH).nullish() })
  .passthrough()
const barSchema = z
  .object({
    t: z.string(),
    o: z.union([z.string(), z.number()]),
    h: z.union([z.string(), z.number()]),
    l: z.union([z.string(), z.number()]),
    c: z.union([z.string(), z.number()]),
    v: z.union([z.string(), z.number()]),
    vw: z.union([z.string(), z.number()]),
    n: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough()
const barsResponseSchema = pageEnvelopeSchema.extend({
  bars: z.record(z.string(), z.array(barSchema)).default({}),
})
const tradeSchema = z
  .object({
    t: z.string(),
    p: z.union([z.string(), z.number()]),
    s: z.union([z.string(), z.number()]),
    i: z.union([z.string(), z.number()]).optional(),
    x: z.string().optional(),
    c: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough()
const tradesResponseSchema = pageEnvelopeSchema.extend({
  trades: z.record(z.string(), z.array(tradeSchema)).default({}),
})
const contractSchema = z
  .object({
    symbol: z.string(),
    expiration_date: z.string(),
    type: z.enum(["call", "put"]),
    strike_price: z.union([z.string(), z.number()]),
    status: z.string(),
    tradable: z.boolean(),
    style: z.string(),
    size: z.union([z.string(), z.number()]),
    open_interest: z.union([z.string(), z.number()]).nullish(),
    open_interest_date: z.string().nullish(),
  })
  .passthrough()
const contractsResponseSchema = pageEnvelopeSchema.extend({
  option_contracts: z.array(contractSchema).default([]),
})
const calendarSchema = z.array(
  z
    .object({
      date: z.string(),
      open: z.string(),
      close: z.string(),
    })
    .passthrough(),
)

export type HistoricalDataPage = Readonly<{
  records: readonly BacktestDatasetRecordV1[]
  nextPageToken?: string
}>

export type AlpacaHistoricalClient = Readonly<{
  getCalendar(input: Readonly<{
    fromDate: string
    toDate: string
    signal: AbortSignal
  }>): Promise<readonly MarketSessionRecordV1[]>
  getUnderlyingBarsPage(input: Readonly<{
    timeframe: "1DAY" | "1MINUTE"
    fromDate: string
    toDate: string
    pageToken?: string
    signal: AbortSignal
  }>): Promise<HistoricalDataPage>
  getOptionContractsPage(input: Readonly<{
    fromDate: string
    toDate: string
    status: "active" | "inactive"
    pageToken?: string
    signal: AbortSignal
  }>): Promise<HistoricalDataPage>
  getOptionBarsPage(input: Readonly<{
    contractSymbols: readonly string[]
    timeframe: "1DAY" | "1MINUTE"
    fromDate: string
    toDate: string
    pageToken?: string
    signal: AbortSignal
  }>): Promise<HistoricalDataPage>
  getOptionTradesPage(input: Readonly<{
    contractSymbols: readonly string[]
    fromDate: string
    toDate: string
    pageToken?: string
    signal: AbortSignal
  }>): Promise<HistoricalDataPage>
}>

export type CreateAlpacaHistoricalClientOptions = Readonly<{
  apiKey: string
  secretKey: string
  dataBaseUrl?: string
  tradingBaseUrl?: string
  fetch?: typeof fetch
  now?: () => Date
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  maxAttempts?: number
  requestTimeoutMs?: number
}>

const normalizeBaseUrl = (
  value: string,
  allowedOrigins: readonly string[],
  allowCustomHost: boolean,
  setting: string,
) => {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      (!allowCustomHost && !allowedOrigins.includes(url.origin))
    ) {
      throw new Error("invalid origin")
    }
    return url.origin
  } catch {
    throw new Error(`${setting} must be a credential-free Alpaca HTTPS URL`)
  }
}

const decimalToInteger = (
  value: string | number,
  scaleDigits: number,
  label: string,
) => {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(String(value))
  if (match?.[1] === undefined) throw new Error(`Alpaca ${label} is invalid`)
  const fraction = match[2] ?? ""
  if (
    fraction.length > scaleDigits &&
    /[1-9]/u.test(fraction.slice(scaleDigits))
  ) {
    throw new Error(`Alpaca ${label} precision is unsupported`)
  }
  const integer = BigInt(match[1]) * 10n ** BigInt(scaleDigits)
  const fractional = BigInt((fraction.slice(0, scaleDigits) + "0".repeat(scaleDigits)).slice(0, scaleDigits))
  const result = integer + fractional
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Alpaca ${label} is out of range`)
  }
  return Number(result)
}

const count = (value: string | number, label: string) =>
  decimalToInteger(value, 0, label)

const timestamp = (value: string, label: string) => {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`Alpaca ${label} is invalid`)
  return new Date(parsed).toISOString()
}

const localTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/u

const sessionTimestamp = (date: string, value: string, label: string) =>
  localTime.test(value)
    ? newYorkLocalTime(date, value).toISOString()
    : timestamp(value, label)

const optionSymbols = (values: readonly string[]) => {
  if (
    values.length === 0 ||
    values.length > 100 ||
    values.some((value) => !/^SPY\d{6}[CP]\d{8}$/u.test(value))
  ) {
    throw new Error("Alpaca option symbols are invalid")
  }
  return [...new Set(values)].sort()
}

const pageToken = (value: string | null | undefined) =>
  value === undefined || value === null || value.length === 0
    ? undefined
    : value

const historicalPage = (
  records: readonly BacktestDatasetRecordV1[],
  token: string | null | undefined,
): HistoricalDataPage => {
  const nextPageToken = pageToken(token)
  return {
    records,
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
  }
}

const defaultSleep = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timeout = setTimeout(done, milliseconds)
    function done() {
      clearTimeout(timeout)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
    if (signal.aborted) done()
  })

/** Creates the read-only Alpaca boundary used to acquire replay datasets. */
export function createAlpacaHistoricalClient(
  options: CreateAlpacaHistoricalClientOptions,
): AlpacaHistoricalClient {
  if (!options.apiKey.trim() || !options.secretKey.trim()) {
    throw new Error("Alpaca historical credentials are required")
  }
  const request = options.fetch ?? fetch
  const allowCustomHost = options.fetch !== undefined
  const dataBaseUrl = normalizeBaseUrl(
    options.dataBaseUrl ?? DEFAULT_DATA_URL,
    [DEFAULT_DATA_URL],
    allowCustomHost,
    "ALPACA_MARKET_DATA_BASE_URL",
  )
  const tradingBaseUrl = normalizeBaseUrl(
    options.tradingBaseUrl ?? DEFAULT_TRADING_URL,
    [DEFAULT_TRADING_URL, "https://api.alpaca.markets"],
    allowCustomHost,
    "ALPACA_TRADING_BASE_URL",
  )
  const now = options.now ?? (() => new Date())
  const sleep = options.sleep ?? defaultSleep
  const maxAttempts = options.maxAttempts ?? 3
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new Error("Alpaca historical max attempts are invalid")
  }
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 100 ||
    requestTimeoutMs > 60_000
  ) {
    throw new Error("Alpaca historical request timeout is invalid")
  }

  const getJson = async (url: URL, signal: AbortSignal): Promise<unknown> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(requestTimeoutMs)
      const combinedSignal = AbortSignal.any([signal, timeoutSignal])
      try {
        const response = await request(url, {
          method: "GET",
          redirect: "error",
          headers: {
            "APCA-API-KEY-ID": options.apiKey,
            "APCA-API-SECRET-KEY": options.secretKey,
          },
          signal: combinedSignal,
        })
        if (response.ok) {
          try {
            return await response.json()
          } catch {
            throw new Error("Alpaca historical response is invalid")
          }
        }
        const retryable = response.status === 429 || response.status >= 500
        if (!retryable || attempt === maxAttempts) {
          throw new Error(
            `Alpaca historical request failed with HTTP ${response.status}`,
          )
        }
        const retryAfter = Number(response.headers.get("retry-after"))
        const delay = Number.isFinite(retryAfter)
          ? Math.min(5_000, Math.max(0, retryAfter * 1_000))
          : attempt * 250
        await sleep(delay, signal)
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        if (error instanceof Error && error.message.startsWith("Alpaca historical")) {
          throw error
        }
        if (attempt === maxAttempts) {
          throw new Error("Alpaca historical request failed", { cause: error })
        }
        await sleep(attempt * 250, signal)
      }
    }
    throw new Error("Alpaca historical request failed")
  }

  const setCommon = (
    url: URL,
    input: { fromDate: string; toDate: string; pageToken?: string },
  ) => {
    const fromDate = z.iso.date().parse(input.fromDate)
    const toDate = z.iso.date().parse(input.toDate)
    if (fromDate > toDate) throw new Error("Alpaca historical date range is invalid")
    url.searchParams.set("start", fromDate)
    url.searchParams.set("end", toDate)
    url.searchParams.set("sort", "asc")
    url.searchParams.set("limit", "10000")
    if (input.pageToken !== undefined) {
      url.searchParams.set("page_token", input.pageToken)
    }
  }

  const mapBars = (
    bars: Record<string, z.infer<typeof barSchema>[]>,
    timeframe: "1DAY" | "1MINUTE",
    option: boolean,
  ): readonly (UnderlyingBarRecordV1 | OptionBarRecordV1)[] => {
    const records: (UnderlyingBarRecordV1 | OptionBarRecordV1)[] = []
    for (const [symbol, values] of Object.entries(bars)) {
      for (const bar of values) {
        const common = {
          timeframe,
          timestamp: timestamp(bar.t, "bar timestamp"),
          openMicros: decimalToInteger(bar.o, 6, "bar open"),
          highMicros: decimalToInteger(bar.h, 6, "bar high"),
          lowMicros: decimalToInteger(bar.l, 6, "bar low"),
          closeMicros: decimalToInteger(bar.c, 6, "bar close"),
          volume: count(bar.v, "bar volume"),
          vwapMicros: decimalToInteger(bar.vw, 6, "bar VWAP"),
        }
        records.push(
          option
            ? {
                recordType: "OPTION_BAR",
                contractSymbol: symbol,
                tradeCount: count(bar.n ?? 0, "bar trade count"),
                ...common,
              }
            : { recordType: "UNDERLYING_BAR", symbol: "SPY", ...common },
        )
      }
    }
    return records
  }

  return {
    async getCalendar(input) {
      const fromDate = z.iso.date().parse(input.fromDate)
      const toDate = z.iso.date().parse(input.toDate)
      if (fromDate > toDate) throw new Error("Alpaca historical date range is invalid")
      const url = new URL("/v2/calendar", tradingBaseUrl)
      url.searchParams.set("start", fromDate)
      url.searchParams.set("end", toDate)
      const parsed = calendarSchema.safeParse(await getJson(url, input.signal))
      if (!parsed.success) throw new Error("Alpaca historical calendar is invalid")
      return parsed.data.map((session) => ({
        recordType: "MARKET_SESSION" as const,
        date: z.iso.date().parse(session.date),
        open: sessionTimestamp(session.date, session.open, "calendar open"),
        close: sessionTimestamp(session.date, session.close, "calendar close"),
      }))
    },
    async getUnderlyingBarsPage(input) {
      const url = new URL("/v2/stocks/bars", dataBaseUrl)
      setCommon(url, input)
      url.searchParams.set("symbols", "SPY")
      url.searchParams.set("timeframe", input.timeframe === "1DAY" ? "1Day" : "1Min")
      url.searchParams.set("feed", "iex")
      url.searchParams.set("adjustment", "all")
      const parsed = barsResponseSchema.safeParse(await getJson(url, input.signal))
      if (!parsed.success) throw new Error("Alpaca historical bars are invalid")
      return historicalPage(
        mapBars(parsed.data.bars, input.timeframe, false),
        parsed.data.next_page_token,
      )
    },
    async getOptionContractsPage(input) {
      const url = new URL("/v2/options/contracts", tradingBaseUrl)
      url.searchParams.set("underlying_symbols", "SPY")
      url.searchParams.set("expiration_date_gte", z.iso.date().parse(input.fromDate))
      url.searchParams.set("expiration_date_lte", z.iso.date().parse(input.toDate))
      url.searchParams.set("status", input.status)
      url.searchParams.set("limit", "1000")
      if (input.pageToken !== undefined) url.searchParams.set("page_token", input.pageToken)
      const parsed = contractsResponseSchema.safeParse(await getJson(url, input.signal))
      if (!parsed.success) throw new Error("Alpaca option contracts are invalid")
      const retrievedAt = now().toISOString()
      const records: OptionContractRecordV1[] = parsed.data.option_contracts.map(
        (contract) => ({
          recordType: "OPTION_CONTRACT",
          contractSymbol: contract.symbol,
          expirationDate: z.iso.date().parse(contract.expiration_date),
          optionType: contract.type === "call" ? "CALL" : "PUT",
          strikeCentsPerShare: decimalToInteger(contract.strike_price, 2, "contract strike"),
          active: contract.status === "active",
          tradable: contract.tradable,
          exerciseStyle:
            contract.style === "american"
              ? "AMERICAN"
              : contract.style === "european"
                ? "EUROPEAN"
                : "UNKNOWN",
          multiplier: count(contract.size, "contract multiplier"),
          retrievedAt,
          ...(contract.open_interest === undefined || contract.open_interest === null
            ? {}
            : {
                openInterest: count(contract.open_interest, "open interest"),
                openInterestDate: z.iso.date().parse(contract.open_interest_date),
              }),
        }),
      )
      return historicalPage(records, parsed.data.next_page_token)
    },
    async getOptionBarsPage(input) {
      const symbols = optionSymbols(input.contractSymbols)
      const url = new URL("/v1beta1/options/bars", dataBaseUrl)
      setCommon(url, input)
      url.searchParams.set("symbols", symbols.join(","))
      url.searchParams.set("timeframe", input.timeframe === "1DAY" ? "1Day" : "1Min")
      const parsed = barsResponseSchema.safeParse(await getJson(url, input.signal))
      if (!parsed.success) throw new Error("Alpaca historical option bars are invalid")
      return historicalPage(
        mapBars(parsed.data.bars, input.timeframe, true),
        parsed.data.next_page_token,
      )
    },
    async getOptionTradesPage(input) {
      const symbols = optionSymbols(input.contractSymbols)
      const url = new URL("/v1beta1/options/trades", dataBaseUrl)
      setCommon(url, input)
      url.searchParams.set("symbols", symbols.join(","))
      const parsed = tradesResponseSchema.safeParse(await getJson(url, input.signal))
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".")}:${issue.code}`)
          .join(",")
        throw new Error(`Alpaca historical option trades are invalid (${issues})`)
      }
      const records: OptionTradeRecordV1[] = Object.entries(parsed.data.trades).flatMap(
        ([contractSymbol, trades]) =>
          trades.map((trade) => ({
            recordType: "OPTION_TRADE",
            contractSymbol,
            timestamp: timestamp(trade.t, "trade timestamp"),
            priceMicros: decimalToInteger(trade.p, 6, "trade price"),
            size: count(trade.s, "trade size"),
            ...(trade.i === undefined ? {} : { tradeId: String(trade.i) }),
            ...(trade.x === undefined ? {} : { exchange: trade.x }),
            conditions:
              trade.c === undefined
                ? []
                : typeof trade.c === "string"
                  ? [trade.c]
                  : trade.c,
          })),
      )
      return historicalPage(records, parsed.data.next_page_token)
    },
  }
}
