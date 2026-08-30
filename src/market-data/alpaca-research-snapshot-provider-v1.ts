import { z } from "zod"

import {
  buildOptionUniverseSnapshotV1,
  buildUnderlyingSessionSnapshotV1,
  validateResearchSnapshotPairV1,
  type OptionUniverseSnapshotBuildFailureCode,
  type UnderlyingSnapshotBuildFailureCode,
} from "../contracts/research-market-snapshot-builders-v1.js"
import {
  MAX_OPTION_UNIVERSE_CONTRACTS,
  MAX_REGULAR_SESSION_MINUTE_BARS,
  RESEARCH_SNAPSHOT_MAX_DTE,
  RESEARCH_SNAPSHOT_MIN_DTE,
  RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT,
  researchSnapshotUtcTimestampV1Schema,
  type OptionUniverseContractV1,
  type OptionUniverseSnapshotV1,
  type UnderlyingSessionSnapshotV1,
} from "../contracts/research-market-snapshot-v1.js"
import {
  newYorkDate,
  newYorkLocalTime,
} from "../scheduling/research-eligibility.js"
import {
  parseAlpacaOptionSymbol,
  validateSpyOptionUniverseV1,
} from "../shared/alpaca-option-identity.js"
import {
  floorNanosecondsToIsoMilliseconds,
  parseExactCents,
  parseRfc3339Nanoseconds,
} from "../shared/value-normalization.js"
import { CURRENT_STRATEGY_MANIFEST } from "../strategy/strategy-registry.js"

const DEFAULT_DATA_URL = "https://data.alpaca.markets"
const DEFAULT_TRADING_URL = "https://paper-api.alpaca.markets"
const MAX_PAGE_TOKEN_LENGTH = 4_096
const CONTRACT_PAGE_SIZE = 1_000
const OPTION_SNAPSHOT_SYMBOL_LIMIT = 100
const OPTION_SNAPSHOT_PAGE_LIMIT = 1_000
const MAX_MINUTE_CAPTURE_ATTEMPTS = 3
const CALENDAR_LOOKBACK_DAYS = 120

const decimal = z.union([z.string(), z.number()])
const pageEnvelopeSchema = z
  .object({
    next_page_token: z.union([
      z.string().min(1).max(MAX_PAGE_TOKEN_LENGTH),
      z.null(),
    ]),
  })
  .passthrough()
const calendarResponseSchema = z.array(
  z
    .object({ date: z.string(), open: z.string(), close: z.string() })
    .passthrough(),
)
const barSchema = z
  .object({
    t: z.string(),
    o: decimal,
    h: decimal,
    l: decimal,
    c: decimal,
    v: decimal,
    vw: decimal,
  })
  .passthrough()
const barsResponseSchema = pageEnvelopeSchema.extend({
  bars: z.record(z.string(), z.array(barSchema)).default({}),
})
const stockQuoteSchema = z
  .object({ t: z.string(), bp: decimal, ap: decimal })
  .passthrough()
const stockQuotesResponseSchema = z
  .object({ quotes: z.record(z.string(), stockQuoteSchema) })
  .passthrough()
const optionContractSchema = z
  .object({
    symbol: z.string(),
    underlying_symbol: z.string(),
    expiration_date: z.string(),
    type: z.enum(["call", "put"]),
    strike_price: decimal,
    status: z.string(),
    tradable: z.boolean(),
    style: z.string(),
    multiplier: decimal,
    open_interest: decimal,
    open_interest_date: z.string(),
  })
  .passthrough()
const optionContractsResponseSchema = pageEnvelopeSchema.extend({
  option_contracts: z.array(optionContractSchema).default([]),
})
const optionSnapshotSchema = z
  .object({
    latestQuote: z
      .object({ t: z.string(), bp: decimal, ap: decimal })
      .passthrough(),
    greeks: z
      .object({
        delta: decimal,
        gamma: decimal,
        theta: decimal,
        vega: decimal,
      })
      .passthrough(),
    impliedVolatility: decimal,
    dailyBar: z.object({ t: z.string(), v: decimal }).passthrough(),
  })
  .passthrough()
const optionSnapshotsResponseSchema = pageEnvelopeSchema.extend({
  snapshots: z.record(z.string(), optionSnapshotSchema).default({}),
})
const captureInputSchema = z
  .object({
    sessionDate: z.iso.date(),
    slotStartedAt: researchSnapshotUtcTimestampV1Schema,
  })
  .strict()

export const RESEARCH_SNAPSHOT_PROVIDER_FAILURE_CODES = Object.freeze([
  "CAPTURE_INPUT_INVALID",
  "CAPTURE_TIME_INVALID",
  "REQUEST_TIMED_OUT",
  "PROVIDER_RATE_LIMITED",
  "CALENDAR_REQUEST_FAILED",
  "CALENDAR_RESPONSE_INVALID",
  "DAILY_BARS_REQUEST_FAILED",
  "DAILY_BARS_RESPONSE_INVALID",
  "MINUTE_BARS_REQUEST_FAILED",
  "MINUTE_BARS_RESPONSE_INVALID",
  "UNDERLYING_QUOTE_REQUEST_FAILED",
  "UNDERLYING_QUOTE_RESPONSE_INVALID",
  "OPTION_CONTRACTS_REQUEST_FAILED",
  "OPTION_CONTRACTS_RESPONSE_INVALID",
  "OPTION_SNAPSHOTS_REQUEST_FAILED",
  "OPTION_SNAPSHOTS_RESPONSE_INVALID",
  "PAGINATION_INCOMPLETE",
  "DATA_CONTAMINATED",
] as const)

type ResearchSnapshotProviderFailureCode =
  (typeof RESEARCH_SNAPSHOT_PROVIDER_FAILURE_CODES)[number]

export type ResearchSnapshotCaptureFailureCode =
  | ResearchSnapshotProviderFailureCode
  | UnderlyingSnapshotBuildFailureCode
  | OptionUniverseSnapshotBuildFailureCode
  | "OPTION_UNIVERSE_SNAPSHOT_INVALID"
  | "SNAPSHOT_LINK_MISMATCH"

export type ResearchSnapshotCaptureInputV1 = Readonly<{
  sessionDate: string
  slotStartedAt: string
  signal: AbortSignal
}>

export type ResearchSnapshotCaptureResultV1 =
  | Readonly<{
      success: true
      underlying: UnderlyingSessionSnapshotV1
      optionUniverse: OptionUniverseSnapshotV1
    }>
  | Readonly<{
      success: false
      reasons: readonly ResearchSnapshotCaptureFailureCode[]
    }>

export type ResearchSnapshotProviderV1 = Readonly<{
  capture(
    input: ResearchSnapshotCaptureInputV1,
  ): Promise<ResearchSnapshotCaptureResultV1>
}>

export type CreateAlpacaResearchSnapshotProviderOptions = Readonly<{
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

class CaptureFailure extends Error {
  constructor(readonly code: ResearchSnapshotCaptureFailureCode) {
    super(code)
    this.name = "CaptureFailure"
  }
}

const failure = (
  ...reasons: readonly ResearchSnapshotCaptureFailureCode[]
): ResearchSnapshotCaptureResultV1 => ({ success: false, reasons })

const normalizeBaseUrl = (
  value: string,
  allowedOrigins: readonly string[],
  setting: string,
) => {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      !allowedOrigins.includes(url.origin)
    ) {
      throw new Error("invalid origin")
    }
    return url.origin
  } catch {
    throw new Error(`${setting} must be a credential-free Alpaca HTTPS URL`)
  }
}

const abortable = <T>(promise: Promise<T>, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted)
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    }
    if (signal.aborted) {
      aborted()
      return
    }
    signal.addEventListener("abort", aborted, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted)
        reject(error)
      },
    )
  })

const defaultSleep = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds)
    function done() {
      clearTimeout(timeout)
      signal.removeEventListener("abort", aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timeout)
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    }
    signal.addEventListener("abort", aborted, { once: true })
    if (signal.aborted) aborted()
  })

const addCalendarDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

const pageToken = (value: string | null | undefined) =>
  value === undefined || value === null || value.length === 0
    ? undefined
    : value

const exactScaledInteger = (
  value: unknown,
  scaleDigits: number,
  round: boolean,
): number | undefined => {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : undefined
  if (text === undefined) return undefined
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(text)
  if (match?.[2] === undefined) return undefined
  const sign = match[1] === "-" ? -1n : 1n
  const fraction = match[3] ?? ""
  const exponent = Number(match[4] ?? "0")
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) {
    return undefined
  }
  let magnitude = BigInt(`${match[2]}${fraction}`)
  const shift = scaleDigits + exponent - fraction.length
  if (shift >= 0) {
    magnitude *= 10n ** BigInt(shift)
  } else {
    const divisor = 10n ** BigInt(-shift)
    const remainder = magnitude % divisor
    if (!round && remainder !== 0n) return undefined
    magnitude /= divisor
    if (round && remainder * 2n >= divisor) magnitude += 1n
  }
  const result = sign * magnitude
  if (
    result < BigInt(Number.MIN_SAFE_INTEGER) ||
    result > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return undefined
  }
  return Number(result)
}

const count = (value: unknown) => {
  const parsed = exactScaledInteger(value, 0, false)
  return parsed !== undefined && parsed >= 0 ? parsed : undefined
}

const positiveCount = (value: unknown) => {
  const parsed = count(value)
  return parsed !== undefined && parsed > 0 ? parsed : undefined
}

const canonicalTimestamp = (value: string) => {
  const parsed = parseRfc3339Nanoseconds(value)
  return parsed === undefined
    ? undefined
    : floorNanosecondsToIsoMilliseconds(parsed)
}

const providerTimestamp = (value: string, retrievedAt: string) => {
  const parsed = parseRfc3339Nanoseconds(value)
  const retrieved = parseRfc3339Nanoseconds(retrievedAt)
  if (parsed === undefined || retrieved === undefined) return undefined
  if (parsed > retrieved) throw new CaptureFailure("OBSERVATION_FROM_FUTURE")
  return floorNanosecondsToIsoMilliseconds(parsed)
}

const calendarTimestamp = (date: string, value: string) => {
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
    return newYorkLocalTime(date, value).toISOString()
  }
  return canonicalTimestamp(value)
}

const normalizeBar = (
  raw: z.infer<typeof barSchema>,
  retrievedAt: string,
  responseFailure: ResearchSnapshotProviderFailureCode,
) => {
  const startedAt = providerTimestamp(raw.t, retrievedAt)
  const openMicrosPerShare = exactScaledInteger(raw.o, 6, false)
  const highMicrosPerShare = exactScaledInteger(raw.h, 6, false)
  const lowMicrosPerShare = exactScaledInteger(raw.l, 6, false)
  const closeMicrosPerShare = exactScaledInteger(raw.c, 6, false)
  const vwapMicrosPerShare = exactScaledInteger(raw.vw, 6, false)
  const volume = positiveCount(raw.v)
  if (
    startedAt === undefined ||
    openMicrosPerShare === undefined || openMicrosPerShare <= 0 ||
    highMicrosPerShare === undefined || highMicrosPerShare <= 0 ||
    lowMicrosPerShare === undefined || lowMicrosPerShare <= 0 ||
    closeMicrosPerShare === undefined || closeMicrosPerShare <= 0 ||
    vwapMicrosPerShare === undefined || vwapMicrosPerShare <= 0 ||
    volume === undefined
  ) {
    throw new CaptureFailure(responseFailure)
  }
  return {
    symbol: "SPY" as const,
    startedAt,
    openMicrosPerShare,
    highMicrosPerShare,
    lowMicrosPerShare,
    closeMicrosPerShare,
    vwapMicrosPerShare,
    volume,
  }
}

/** Creates the read-only Alpaca boundary that captures complete SPY research evidence. */
export function createAlpacaResearchSnapshotProvider(
  options: CreateAlpacaResearchSnapshotProviderOptions,
): ResearchSnapshotProviderV1 {
  if (!options.apiKey.trim() || !options.secretKey.trim()) {
    throw new Error("Alpaca research snapshot credentials are required")
  }
  const request = options.fetch ?? fetch
  const dataBaseUrl = normalizeBaseUrl(
    options.dataBaseUrl ?? DEFAULT_DATA_URL,
    [DEFAULT_DATA_URL],
    "ALPACA_MARKET_DATA_BASE_URL",
  )
  const tradingBaseUrl = normalizeBaseUrl(
    options.tradingBaseUrl ?? DEFAULT_TRADING_URL,
    [DEFAULT_TRADING_URL, "https://api.alpaca.markets"],
    "ALPACA_TRADING_BASE_URL",
  )
  const now = options.now ?? (() => new Date())
  const sleep = options.sleep ?? defaultSleep
  const maxAttempts = options.maxAttempts ?? 3
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new Error("Alpaca research snapshot max attempts are invalid")
  }
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 100 ||
    requestTimeoutMs > 60_000
  ) {
    throw new Error("Alpaca research snapshot request timeout is invalid")
  }

  const applicationTime = () => {
    const value = now()
    if (!Number.isFinite(value.getTime())) {
      throw new CaptureFailure("CAPTURE_TIME_INVALID")
    }
    return value.toISOString()
  }

  const getJson = async (
    url: URL,
    signal: AbortSignal,
    requestFailure: ResearchSnapshotProviderFailureCode,
    responseFailure: ResearchSnapshotProviderFailureCode,
  ): Promise<{ body: unknown; retrievedAt: string }> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(requestTimeoutMs)
      const combinedSignal = AbortSignal.any([signal, timeoutSignal])
      let response: Response
      try {
        response = await abortable(
          request(url, {
            method: "GET",
            redirect: "error",
            headers: {
              "APCA-API-KEY-ID": options.apiKey,
              "APCA-API-SECRET-KEY": options.secretKey,
            },
            signal: combinedSignal,
          }),
          combinedSignal,
        )
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        if (attempt === maxAttempts) {
          throw new CaptureFailure(
            timeoutSignal.aborted ? "REQUEST_TIMED_OUT" : requestFailure,
          )
        }
        await sleep(attempt * 250, signal)
        continue
      }

      if (!response.ok) {
        if (response.status === 429) {
          if (attempt === maxAttempts) {
            throw new CaptureFailure("PROVIDER_RATE_LIMITED")
          }
          const retryAfterHeader = response.headers.get("retry-after")
          const retryAfter =
            retryAfterHeader === null || retryAfterHeader.trim() === ""
              ? Number.NaN
              : Number(retryAfterHeader)
          await sleep(
            Number.isFinite(retryAfter) && retryAfter >= 0
              ? Math.min(5_000, retryAfter * 1_000)
              : attempt * 250,
            signal,
          )
          continue
        }
        if (response.status >= 500 && attempt < maxAttempts) {
          await sleep(attempt * 250, signal)
          continue
        }
        throw new CaptureFailure(requestFailure)
      }

      try {
        return {
          body: await abortable(response.json(), combinedSignal),
          retrievedAt: applicationTime(),
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        if (timeoutSignal.aborted) {
          if (attempt === maxAttempts) {
            throw new CaptureFailure("REQUEST_TIMED_OUT")
          }
          await sleep(attempt * 250, signal)
          continue
        }
        throw new CaptureFailure(responseFailure)
      }
    }
    throw new CaptureFailure(requestFailure)
  }

  const captureCalendar = async (sessionDate: string, signal: AbortSignal) => {
    const url = new URL("/v2/calendar", tradingBaseUrl)
    url.searchParams.set(
      "start",
      addCalendarDays(sessionDate, -CALENDAR_LOOKBACK_DAYS),
    )
    url.searchParams.set("end", sessionDate)
    const response = await getJson(
      url,
      signal,
      "CALENDAR_REQUEST_FAILED",
      "CALENDAR_RESPONSE_INVALID",
    )
    const parsed = calendarResponseSchema.safeParse(response.body)
    if (!parsed.success) throw new CaptureFailure("CALENDAR_RESPONSE_INVALID")

    const dates = parsed.data.map(({ date }) => date)
    if (
      new Set(dates).size !== dates.length ||
      dates.some((date) => !z.iso.date().safeParse(date).success || date > sessionDate)
    ) {
      throw new CaptureFailure("CALENDAR_RESPONSE_INVALID")
    }
    let sessions: Array<{ date: string; openAt: string; closeAt: string }>
    try {
      sessions = parsed.data
        .map((session) => {
          const openAt = calendarTimestamp(session.date, session.open)
          const closeAt = calendarTimestamp(session.date, session.close)
          if (
            openAt === undefined ||
            closeAt === undefined ||
            Date.parse(openAt) >= Date.parse(closeAt)
          ) {
            throw new CaptureFailure("CALENDAR_RESPONSE_INVALID")
          }
          return { date: session.date, openAt, closeAt }
        })
        .sort((left, right) =>
          left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
        )
    } catch (error) {
      if (error instanceof CaptureFailure) throw error
      throw new CaptureFailure("CALENDAR_RESPONSE_INVALID")
    }
    const current = sessions.filter(({ date }) => date === sessionDate)
    const previousSessionDates = sessions
      .filter(({ date }) => date < sessionDate)
      .map(({ date }) => date)
      .slice(-RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT)
    if (
      current.length !== 1 ||
      previousSessionDates.length !== RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT
    ) {
      throw new CaptureFailure("DATA_INCOMPLETE")
    }
    return {
      session: {
        date: sessionDate,
        openAt: current[0]!.openAt,
        closeAt: current[0]!.closeAt,
        previousSessionDates,
      },
      retrievedAt: response.retrievedAt,
    }
  }

  const captureBars = async (
    input: {
      timeframe: "1Day" | "1Min"
      start: string
      end: string
      maximumRecords: number
      requestFailure: "DAILY_BARS_REQUEST_FAILED" | "MINUTE_BARS_REQUEST_FAILED"
      responseFailure: "DAILY_BARS_RESPONSE_INVALID" | "MINUTE_BARS_RESPONSE_INVALID"
    },
    signal: AbortSignal,
  ) => {
    const records: ReturnType<typeof normalizeBar>[] = []
    const seenTokens = new Set<string>()
    let nextPageToken: string | undefined
    let retrievedAt = applicationTime()
    for (let page = 0; page <= input.maximumRecords; page += 1) {
      const url = new URL("/v2/stocks/bars", dataBaseUrl)
      url.searchParams.set("symbols", "SPY")
      url.searchParams.set("timeframe", input.timeframe)
      url.searchParams.set("start", input.start)
      url.searchParams.set("end", input.end)
      url.searchParams.set("feed", "iex")
      url.searchParams.set("adjustment", "all")
      url.searchParams.set("sort", "asc")
      url.searchParams.set("limit", "10000")
      if (nextPageToken !== undefined) {
        url.searchParams.set("page_token", nextPageToken)
      }
      const response = await getJson(
        url,
        signal,
        input.requestFailure,
        input.responseFailure,
      )
      retrievedAt = response.retrievedAt
      const parsed = barsResponseSchema.safeParse(response.body)
      if (!parsed.success) throw new CaptureFailure(input.responseFailure)
      const symbols = Object.keys(parsed.data.bars)
      if (symbols.some((symbol) => symbol !== "SPY")) {
        throw new CaptureFailure("DATA_CONTAMINATED")
      }
      const pageRecords = (parsed.data.bars.SPY ?? []).map((bar) =>
        normalizeBar(bar, response.retrievedAt, input.responseFailure),
      )
      records.push(...pageRecords)
      if (records.length > input.maximumRecords) {
        throw new CaptureFailure("DATA_CONTAMINATED")
      }
      const token = pageToken(parsed.data.next_page_token)
      if (token === undefined) return { records, retrievedAt }
      if (
        pageRecords.length === 0 ||
        seenTokens.has(token) ||
        records.length === input.maximumRecords
      ) {
        throw new CaptureFailure("PAGINATION_INCOMPLETE")
      }
      seenTokens.add(token)
      nextPageToken = token
    }
    throw new CaptureFailure("PAGINATION_INCOMPLETE")
  }

  const captureContracts = async (sessionDate: string, signal: AbortSignal) => {
    const contracts: Array<{
      contractSymbol: string
      expirationDate: string
      optionType: "CALL" | "PUT"
      strikeCentsPerShare: number
      active: boolean
      tradable: boolean
      exerciseStyle: "AMERICAN" | "EUROPEAN" | "UNKNOWN"
      multiplier: number
      openInterest: { asOfDate: string; contracts: number }
    }> = []
    const seenTokens = new Set<string>()
    const seenSymbols = new Set<string>()
    let nextPageToken: string | undefined
    let retrievedAt = applicationTime()
    for (let page = 0; page < MAX_OPTION_UNIVERSE_CONTRACTS; page += 1) {
      const url = new URL("/v2/options/contracts", tradingBaseUrl)
      url.searchParams.set("underlying_symbols", "SPY")
      url.searchParams.set(
        "expiration_date_gte",
        addCalendarDays(sessionDate, RESEARCH_SNAPSHOT_MIN_DTE),
      )
      url.searchParams.set(
        "expiration_date_lte",
        addCalendarDays(sessionDate, RESEARCH_SNAPSHOT_MAX_DTE),
      )
      url.searchParams.set("status", "active")
      url.searchParams.set("limit", String(CONTRACT_PAGE_SIZE))
      if (nextPageToken !== undefined) {
        url.searchParams.set("page_token", nextPageToken)
      }
      const response = await getJson(
        url,
        signal,
        "OPTION_CONTRACTS_REQUEST_FAILED",
        "OPTION_CONTRACTS_RESPONSE_INVALID",
      )
      retrievedAt = response.retrievedAt
      const parsed = optionContractsResponseSchema.safeParse(response.body)
      if (!parsed.success) {
        throw new CaptureFailure("OPTION_CONTRACTS_RESPONSE_INVALID")
      }
      for (const raw of parsed.data.option_contracts) {
        if (raw.underlying_symbol !== "SPY") {
          throw new CaptureFailure("DATA_CONTAMINATED")
        }
        if (seenSymbols.has(raw.symbol)) {
          throw new CaptureFailure("DUPLICATE_RECORD")
        }
        const identity = parseAlpacaOptionSymbol(raw.symbol)
        const strikeCentsPerShare = parseExactCents(raw.strike_price)
        const multiplier = positiveCount(raw.multiplier)
        const openInterest = count(raw.open_interest)
        if (
          !identity.success ||
          !validateSpyOptionUniverseV1(identity.identity).success ||
          !z.iso.date().safeParse(raw.expiration_date).success ||
          strikeCentsPerShare === undefined || strikeCentsPerShare <= 0 ||
          multiplier === undefined ||
          openInterest === undefined ||
          !z.iso.date().safeParse(raw.open_interest_date).success
        ) {
          throw new CaptureFailure("OPTION_CONTRACTS_RESPONSE_INVALID")
        }
        seenSymbols.add(raw.symbol)
        contracts.push({
          contractSymbol: raw.symbol,
          expirationDate: raw.expiration_date,
          optionType: raw.type === "call" ? "CALL" : "PUT",
          strikeCentsPerShare,
          active: raw.status === "active",
          tradable: raw.tradable,
          exerciseStyle:
            raw.style === "american"
              ? "AMERICAN"
              : raw.style === "european"
                ? "EUROPEAN"
                : "UNKNOWN",
          multiplier,
          openInterest: {
            asOfDate: raw.open_interest_date,
            contracts: openInterest,
          },
        })
      }
      if (contracts.length > MAX_OPTION_UNIVERSE_CONTRACTS) {
        throw new CaptureFailure("DATA_CONTAMINATED")
      }
      const token = pageToken(parsed.data.next_page_token)
      if (token === undefined) {
        if (contracts.length === 0) throw new CaptureFailure("DATA_INCOMPLETE")
        return { contracts, retrievedAt }
      }
      if (
        parsed.data.option_contracts.length === 0 ||
        seenTokens.has(token) ||
        contracts.length === MAX_OPTION_UNIVERSE_CONTRACTS
      ) {
        throw new CaptureFailure("PAGINATION_INCOMPLETE")
      }
      seenTokens.add(token)
      nextPageToken = token
    }
    throw new CaptureFailure("PAGINATION_INCOMPLETE")
  }

  const captureOptionSnapshotChunk = async (
    symbols: readonly string[],
    signal: AbortSignal,
  ) => {
    const snapshots = new Map<
      string,
      { snapshot: z.infer<typeof optionSnapshotSchema>; retrievedAt: string }
    >()
    const seenTokens = new Set<string>()
    let nextPageToken: string | undefined
    let retrievedAt = applicationTime()
    for (let page = 0; page < symbols.length; page += 1) {
      const url = new URL("/v1beta1/options/snapshots", dataBaseUrl)
      url.searchParams.set("symbols", symbols.join(","))
      url.searchParams.set("feed", "indicative")
      url.searchParams.set("limit", String(OPTION_SNAPSHOT_PAGE_LIMIT))
      if (nextPageToken !== undefined) {
        url.searchParams.set("page_token", nextPageToken)
      }
      const response = await getJson(
        url,
        signal,
        "OPTION_SNAPSHOTS_REQUEST_FAILED",
        "OPTION_SNAPSHOTS_RESPONSE_INVALID",
      )
      retrievedAt = response.retrievedAt
      const parsed = optionSnapshotsResponseSchema.safeParse(response.body)
      if (!parsed.success) {
        throw new CaptureFailure("OPTION_SNAPSHOTS_RESPONSE_INVALID")
      }
      const entries = Object.entries(parsed.data.snapshots)
      for (const [symbol, snapshot] of entries) {
        if (!symbols.includes(symbol)) throw new CaptureFailure("DATA_CONTAMINATED")
        if (snapshots.has(symbol)) throw new CaptureFailure("DUPLICATE_RECORD")
        snapshots.set(symbol, {
          snapshot,
          retrievedAt: response.retrievedAt,
        })
      }
      const token = pageToken(parsed.data.next_page_token)
      if (token === undefined) return { snapshots, retrievedAt }
      if (
        entries.length === 0 ||
        seenTokens.has(token) ||
        snapshots.size === symbols.length
      ) {
        throw new CaptureFailure("PAGINATION_INCOMPLETE")
      }
      seenTokens.add(token)
      nextPageToken = token
    }
    throw new CaptureFailure("PAGINATION_INCOMPLETE")
  }

  const captureOptionSnapshots = async (
    symbols: readonly string[],
    signal: AbortSignal,
  ) => {
    if (symbols.length === 0) {
      return {
        snapshots: new Map<
          string,
          { snapshot: z.infer<typeof optionSnapshotSchema>; retrievedAt: string }
        >(),
        retrievedAt: applicationTime(),
      }
    }
    const snapshots = new Map<
      string,
      { snapshot: z.infer<typeof optionSnapshotSchema>; retrievedAt: string }
    >()
    let retrievedAt = ""
    for (let index = 0; index < symbols.length; index += OPTION_SNAPSHOT_SYMBOL_LIMIT) {
      const chunk = symbols.slice(index, index + OPTION_SNAPSHOT_SYMBOL_LIMIT)
      const result = await captureOptionSnapshotChunk(chunk, signal)
      if (retrievedAt === "" || result.retrievedAt > retrievedAt) {
        retrievedAt = result.retrievedAt
      }
      for (const [symbol, snapshot] of result.snapshots) {
        if (snapshots.has(symbol)) throw new CaptureFailure("DUPLICATE_RECORD")
        snapshots.set(symbol, snapshot)
      }
    }
    if (
      snapshots.size !== symbols.length ||
      symbols.some((symbol) => !snapshots.has(symbol))
    ) {
      throw new CaptureFailure("DATA_INCOMPLETE")
    }
    return { snapshots, retrievedAt }
  }

  const captureUnderlyingQuote = async (signal: AbortSignal) => {
    const url = new URL("/v2/stocks/quotes/latest", dataBaseUrl)
    url.searchParams.set("symbols", "SPY")
    url.searchParams.set("feed", "iex")
    const response = await getJson(
      url,
      signal,
      "UNDERLYING_QUOTE_REQUEST_FAILED",
      "UNDERLYING_QUOTE_RESPONSE_INVALID",
    )
    const parsed = stockQuotesResponseSchema.safeParse(response.body)
    if (!parsed.success) {
      throw new CaptureFailure("UNDERLYING_QUOTE_RESPONSE_INVALID")
    }
    const symbols = Object.keys(parsed.data.quotes)
    if (symbols.length !== 1 || symbols[0] !== "SPY") {
      throw new CaptureFailure("DATA_CONTAMINATED")
    }
    const raw = parsed.data.quotes.SPY!
    const providerTime = providerTimestamp(raw.t, response.retrievedAt)
    const bidMicrosPerShare = exactScaledInteger(raw.bp, 6, false)
    const askMicrosPerShare = exactScaledInteger(raw.ap, 6, false)
    if (
      providerTime === undefined ||
      bidMicrosPerShare === undefined || bidMicrosPerShare <= 0 ||
      askMicrosPerShare === undefined || askMicrosPerShare <= 0
    ) {
      throw new CaptureFailure("UNDERLYING_QUOTE_RESPONSE_INVALID")
    }
    return {
      quote: {
        symbol: "SPY" as const,
        providerTimestamp: providerTime,
        bidMicrosPerShare,
        askMicrosPerShare,
      },
      retrievedAt: response.retrievedAt,
    }
  }

  const normalizeOptionContract = (
    contract: Awaited<ReturnType<typeof captureContracts>>["contracts"][number],
    snapshot: z.infer<typeof optionSnapshotSchema>,
    snapshotsRetrievedAt: string,
    sessionDate: string,
  ): OptionUniverseContractV1 => {
    const quoteTimestamp = providerTimestamp(
      snapshot.latestQuote.t,
      snapshotsRetrievedAt,
    )
    const volumeTimestamp = providerTimestamp(
      snapshot.dailyBar.t,
      snapshotsRetrievedAt,
    )
    const bidCentsPerShare = parseExactCents(snapshot.latestQuote.bp)
    const askCentsPerShare = parseExactCents(snapshot.latestQuote.ap)
    const deltaMillionths = exactScaledInteger(snapshot.greeks.delta, 6, true)
    const gammaMillionths = exactScaledInteger(snapshot.greeks.gamma, 6, true)
    const thetaMillionths = exactScaledInteger(snapshot.greeks.theta, 6, true)
    const vegaMillionths = exactScaledInteger(snapshot.greeks.vega, 6, true)
    const impliedVolatilityMillionths = exactScaledInteger(
      snapshot.impliedVolatility,
      6,
      true,
    )
    const volume = count(snapshot.dailyBar.v)
    if (
      quoteTimestamp === undefined ||
      volumeTimestamp === undefined ||
      newYorkDate(new Date(volumeTimestamp)) !== sessionDate ||
      bidCentsPerShare === undefined || bidCentsPerShare < 0 ||
      askCentsPerShare === undefined || askCentsPerShare <= 0 ||
      deltaMillionths === undefined ||
      gammaMillionths === undefined ||
      thetaMillionths === undefined ||
      vegaMillionths === undefined ||
      impliedVolatilityMillionths === undefined ||
      impliedVolatilityMillionths <= 0 ||
      volume === undefined
    ) {
      throw new CaptureFailure("OPTION_SNAPSHOTS_RESPONSE_INVALID")
    }
    return {
      ...contract,
      quote: {
        providerTimestamp: quoteTimestamp,
        bidCentsPerShare,
        askCentsPerShare,
      },
      greeks: {
        deltaMillionths,
        gammaMillionths,
        thetaMillionths,
        vegaMillionths,
        impliedVolatilityMillionths,
      },
      currentSessionVolume: {
        sessionDate,
        providerTimestamp: volumeTimestamp,
        contracts: volume,
      },
    }
  }

  return {
    async capture(input): Promise<ResearchSnapshotCaptureResultV1> {
      if (input.signal.aborted) {
        throw input.signal.reason ?? new DOMException("Aborted", "AbortError")
      }
      const parsedInput = captureInputSchema.safeParse({
        sessionDate: input.sessionDate,
        slotStartedAt: input.slotStartedAt,
      })
      if (!parsedInput.success) return failure("CAPTURE_INPUT_INVALID")

      try {
        const captureStartedAt = applicationTime()
        if (
          newYorkDate(new Date(captureStartedAt)) !== parsedInput.data.sessionDate ||
          newYorkDate(new Date(parsedInput.data.slotStartedAt)) !==
            parsedInput.data.sessionDate ||
          Date.parse(parsedInput.data.slotStartedAt) > Date.parse(captureStartedAt)
        ) {
          return failure("CAPTURE_TIME_INVALID")
        }

        const calendar = await captureCalendar(
          parsedInput.data.sessionDate,
          input.signal,
        )
        const dailyBars = await captureBars(
          {
            timeframe: "1Day",
            start: calendar.session.previousSessionDates[0]!,
            end: `${calendar.session.previousSessionDates.at(-1)!}T23:59:59.999Z`,
            maximumRecords: RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT,
            requestFailure: "DAILY_BARS_REQUEST_FAILED",
            responseFailure: "DAILY_BARS_RESPONSE_INVALID",
          },
          input.signal,
        )
        const contractCapture = await captureContracts(
          parsedInput.data.sessionDate,
          input.signal,
        )
        const requestedContractSymbols = contractCapture.contracts
          .map(({ contractSymbol }) => contractSymbol)
          .sort()
        const optionSnapshotCapture = await captureOptionSnapshots(
          requestedContractSymbols,
          input.signal,
        )
        const underlyingQuote = await captureUnderlyingQuote(input.signal)

        let minuteBars:
          | Awaited<ReturnType<typeof captureBars>>
          | undefined
        let observedAt: string | undefined
        for (let attempt = 0; attempt < MAX_MINUTE_CAPTURE_ATTEMPTS; attempt += 1) {
          const cutoffAt = applicationTime()
          const open = Date.parse(calendar.session.openAt)
          const close = Date.parse(calendar.session.closeAt)
          const cutoff = Date.parse(cutoffAt)
          const expectedCount = Math.max(
            0,
            Math.floor((Math.min(cutoff, close) - open) / 60_000),
          )
          if (expectedCount > MAX_REGULAR_SESSION_MINUTE_BARS) {
            throw new CaptureFailure("DATA_INCOMPLETE")
          }
          if (expectedCount === 0) {
            minuteBars = { records: [], retrievedAt: applicationTime() }
          } else {
            minuteBars = await captureBars(
              {
                timeframe: "1Min",
                start: calendar.session.openAt,
                end: new Date(open + expectedCount * 60_000 - 1).toISOString(),
                maximumRecords: MAX_REGULAR_SESSION_MINUTE_BARS,
                requestFailure: "MINUTE_BARS_REQUEST_FAILED",
                responseFailure: "MINUTE_BARS_RESPONSE_INVALID",
              },
              input.signal,
            )
          }
          observedAt = applicationTime()
          const observedCount = Math.max(
            0,
            Math.floor(
              (Math.min(Date.parse(observedAt), close) - open) / 60_000,
            ),
          )
          if (observedCount === expectedCount) break
          minuteBars = undefined
          observedAt = undefined
        }
        if (minuteBars === undefined || observedAt === undefined) {
          throw new CaptureFailure("DATA_INCOMPLETE")
        }
        const evaluatedAt = applicationTime()
        const times = {
          slotStartedAt: parsedInput.data.slotStartedAt,
          captureStartedAt,
          observedAt,
          evaluatedAt,
        }
        const underlyingResult = buildUnderlyingSessionSnapshotV1({
          strategyManifest: CURRENT_STRATEGY_MANIFEST,
          underlying: "SPY",
          session: calendar.session,
          times,
          sources: {
            calendar: {
              provider: "ALPACA",
              source: "MARKET_CALENDAR",
              retrievedAt: calendar.retrievedAt,
            },
            dailyBars: {
              provider: "ALPACA",
              source: "STOCK_BARS",
              feed: "IEX",
              adjustment: "ALL",
              retrievedAt: dailyBars.retrievedAt,
            },
            minuteBars: {
              provider: "ALPACA",
              source: "STOCK_BARS",
              feed: "IEX",
              marketHours: "REGULAR",
              retrievedAt: minuteBars.retrievedAt,
            },
            quote: {
              provider: "ALPACA",
              source: "STOCK_LATEST_QUOTE",
              feed: "IEX",
              retrievedAt: underlyingQuote.retrievedAt,
            },
          },
          pagination: {
            dailyBars: "NO_NEXT_PAGE_TOKEN",
            minuteBars: "NO_NEXT_PAGE_TOKEN",
          },
          dailyBars: dailyBars.records.map((bar) => ({
            ...bar,
            sessionDate: newYorkDate(new Date(bar.startedAt)),
          })),
          minuteBars: minuteBars.records,
          underlyingQuote: underlyingQuote.quote,
        })
        if (!underlyingResult.success) {
          return { success: false, reasons: underlyingResult.reasons }
        }

        const contracts = contractCapture.contracts.map((contract) => {
          const captured = optionSnapshotCapture.snapshots.get(
            contract.contractSymbol,
          )
          if (captured === undefined) throw new CaptureFailure("DATA_INCOMPLETE")
          return normalizeOptionContract(
            contract,
            captured.snapshot,
            captured.retrievedAt,
            parsedInput.data.sessionDate,
          )
        })
        const optionResult = buildOptionUniverseSnapshotV1(
          underlyingResult.snapshot,
          {
            underlying: "SPY",
            sources: {
              contracts: {
                provider: "ALPACA",
                source: "OPTION_CONTRACTS",
                retrievedAt: contractCapture.retrievedAt,
              },
              marketSnapshots: {
                provider: "ALPACA",
                source: "OPTION_SNAPSHOTS",
                feed: "INDICATIVE",
                retrievedAt: optionSnapshotCapture.retrievedAt,
              },
            },
            contractPaginationTermination: "NO_NEXT_PAGE_TOKEN",
            requestedContractSymbols,
            contracts,
          },
        )
        if (!optionResult.success) {
          return { success: false, reasons: optionResult.reasons }
        }
        const pair = validateResearchSnapshotPairV1(
          underlyingResult.snapshot,
          optionResult.snapshot,
        )
        if (!pair.success) return failure(pair.reason)
        return {
          success: true,
          underlying: pair.underlying,
          optionUniverse: pair.optionUniverse,
        }
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason ?? error
        if (error instanceof CaptureFailure) return failure(error.code)
        throw error
      }
    },
  }
}
