import { z } from "zod"

import {
  collectedOptionContractV1Schema,
  collectedOptionQuoteV1Schema,
  type CollectedOptionContractV1,
  type CollectedOptionQuoteV1,
  type CollectedUnderlyingSpotV1,
  type ForwardCollectionConfigV1,
} from "./contracts-v1.js"
import { parseAlpacaOptionSymbol } from "../../shared/alpaca-option-identity.js"

const MAX_CONTRACT_PAGES = 100

const providerNumber = z.union([z.number(), z.string()])
const contractSchema = z.object({
  id: z.string().min(1).max(160),
  symbol: z.string().min(1).max(64),
  underlying_symbol: z.string().min(1).max(16),
  expiration_date: z.iso.date(),
  type: z.enum(["call", "put"]),
  style: z.string(),
  strike_price: providerNumber,
  size: providerNumber,
  status: z.string().min(1).max(32),
  tradable: z.boolean(),
  open_interest: providerNumber.nullish(),
  open_interest_date: z.iso.date().nullish(),
}).passthrough()
const contractsResponseSchema = z.object({
  option_contracts: z.array(contractSchema),
  next_page_token: z.string().min(1).nullable().optional(),
}).passthrough()

const latestQuoteSchema = z.object({
  bp: providerNumber.nullish(),
  ap: providerNumber.nullish(),
  bs: providerNumber.nullish(),
  as: providerNumber.nullish(),
  bx: z.string().nullish(),
  ax: z.string().nullish(),
  c: z.array(z.string()).nullish(),
  t: z.string().nullish(),
}).passthrough()
const optionSnapshotsSchema = z.object({
  snapshots: z.record(z.string(), z.object({
    latestQuote: latestQuoteSchema.nullish(),
  }).passthrough()),
}).passthrough()

const stockSnapshotSchema = z.object({
  latestTrade: z.object({ p: providerNumber, t: z.string().optional() }).passthrough().nullish(),
  minuteBar: z.object({ c: providerNumber, t: z.string().optional() }).passthrough().nullish(),
  dailyBar: z.object({ c: providerNumber, t: z.string().optional() }).passthrough().nullish(),
}).passthrough()
const stockSnapshotMapSchema = z.record(z.string(), stockSnapshotSchema)
const stockSnapshotsSchema = z.union([
  z.object({ snapshots: stockSnapshotMapSchema }).passthrough()
    .transform(({ snapshots }) => snapshots),
  stockSnapshotMapSchema,
])

const normalizeOrigin = (
  value: string,
  expected: readonly string[],
  setting: string,
  allowCustomHost: boolean,
) => {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      (!allowCustomHost && !expected.includes(url.origin))
    ) throw new Error("invalid origin")
    return url.origin
  } catch {
    throw new Error(`${setting} must be a credential-free Alpaca HTTPS URL`)
  }
}

/** Parses a positive decimal price exactly into $0.005 units. */
export const parseHalfCents = (input: number | string) => {
  const value = String(input)
  const match = /^(\d+)(?:\.(\d{1,3}))?$/u.exec(value)
  if (match === null) return undefined
  const whole = match[1]
  const fraction = (match[2] ?? "").padEnd(3, "0")
  if (whole === undefined || Number(fraction) % 5 !== 0) return undefined
  const thousandths = BigInt(whole) * 1_000n + BigInt(fraction)
  const halfCents = thousandths / 5n
  return halfCents > 0n && halfCents <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(halfCents)
    : undefined
}

const parseCount = (input: number | string | null | undefined) => {
  if (input == null) return undefined
  const value = Number(input)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export type AlpacaForwardCollectionProvider = Readonly<{
  listContracts(input: Readonly<{
    symbols: readonly string[]
    startDate: string
    endDate: string
    signal: AbortSignal
  }>): Promise<readonly CollectedOptionContractV1[]>
  getUnderlyingSpots(input: Readonly<{
    symbols: readonly string[]
    stockFeed: ForwardCollectionConfigV1["stockFeed"]
    signal: AbortSignal
  }>): Promise<readonly CollectedUnderlyingSpotV1[]>
  getOptionQuotes(input: Readonly<{
    optionSymbols: readonly string[]
    feed: ForwardCollectionConfigV1["feed"]
    signal: AbortSignal
  }>): Promise<readonly CollectedOptionQuoteV1[]>
}>

export type AlpacaForwardCollectionProviderOptions = Readonly<{
  apiKey: string
  secretKey: string
  dataBaseUrl?: string
  tradingBaseUrl?: string
  fetch?: typeof fetch
}>

export function createAlpacaForwardCollectionProvider(
  options: AlpacaForwardCollectionProviderOptions,
): AlpacaForwardCollectionProvider {
  const request = options.fetch ?? fetch
  const allowCustomHost = options.fetch !== undefined
  const dataBaseUrl = normalizeOrigin(
    options.dataBaseUrl ?? "https://data.alpaca.markets",
    ["https://data.alpaca.markets"],
    "ALPACA_MARKET_DATA_BASE_URL",
    allowCustomHost,
  )
  const tradingBaseUrl = normalizeOrigin(
    options.tradingBaseUrl ?? "https://paper-api.alpaca.markets",
    ["https://paper-api.alpaca.markets", "https://api.alpaca.markets"],
    "ALPACA_TRADING_BASE_URL",
    allowCustomHost,
  )
  const headers = {
    "APCA-API-KEY-ID": options.apiKey,
    "APCA-API-SECRET-KEY": options.secretKey,
  }

  const get = async (url: URL, signal: AbortSignal, operation: string) => {
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
      throw new Error(`Alpaca ${operation} request failed`)
    }
    if (!response.ok) throw new Error(`Alpaca ${operation} request failed`)
    try {
      return await response.json() as unknown
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      throw new Error(`Alpaca ${operation} response is invalid`)
    }
  }

  return {
    async listContracts({ symbols, startDate, endDate, signal }) {
      const url = new URL("/v2/options/contracts", tradingBaseUrl)
      url.searchParams.set("underlying_symbols", symbols.join(","))
      url.searchParams.set("status", "active")
      url.searchParams.set("expiration_date_gte", startDate)
      url.searchParams.set("expiration_date_lte", endDate)
      url.searchParams.set("limit", "10000")
      const contracts: CollectedOptionContractV1[] = []
      for (let page = 0; page < MAX_CONTRACT_PAGES; page += 1) {
        const parsed = contractsResponseSchema.safeParse(
          await get(url, signal, "option contracts"),
        )
        if (!parsed.success) throw new Error("Alpaca option contracts response is invalid")
        for (const raw of parsed.data.option_contracts) {
          const identity = parseAlpacaOptionSymbol(raw.symbol)
          const multiplier = Number(raw.size)
          const openInterest = parseCount(raw.open_interest)
          const contract = collectedOptionContractV1Schema.safeParse({
            providerContractId: raw.id,
            optionSymbol: raw.symbol,
            underlying: raw.underlying_symbol,
            right: raw.type === "call" ? "CALL" : "PUT",
            strikeThousandthsPerShare: identity.success
              ? identity.identity.strikeThousandthsPerShare
              : Math.round(Number(raw.strike_price) * 1_000),
            expirationDate: raw.expiration_date,
            multiplier,
            style: raw.style.toLowerCase() === "american"
              ? "AMERICAN"
              : raw.style.toLowerCase() === "european"
                ? "EUROPEAN"
                : "UNKNOWN",
            status: raw.status,
            tradable: raw.tradable,
            ...(openInterest === undefined ? {} : { openInterest }),
            ...(raw.open_interest_date == null
              ? {}
              : { openInterestDate: raw.open_interest_date }),
          })
          if (contract.success && identity.success) contracts.push(contract.data)
        }
        const token = parsed.data.next_page_token
        if (token == null) return contracts
        url.searchParams.set("page_token", token)
      }
      throw new Error("Alpaca option contracts pagination limit exceeded")
    },

    async getUnderlyingSpots({ symbols, stockFeed, signal }) {
      const url = new URL("/v2/stocks/snapshots", dataBaseUrl)
      url.searchParams.set("symbols", symbols.join(","))
      url.searchParams.set("feed", stockFeed)
      const parsed = stockSnapshotsSchema.safeParse(
        await get(url, signal, "stock snapshots"),
      )
      if (!parsed.success) throw new Error("Alpaca stock snapshots response is invalid")
      return symbols.flatMap((symbol) => {
        const snapshot = parsed.data[symbol]
        const source = snapshot?.latestTrade !== null && snapshot?.latestTrade !== undefined
          ? { price: snapshot.latestTrade.p, timestamp: snapshot.latestTrade.t }
          : snapshot?.minuteBar !== null && snapshot?.minuteBar !== undefined
            ? { price: snapshot.minuteBar.c, timestamp: snapshot.minuteBar.t }
            : snapshot?.dailyBar !== null && snapshot?.dailyBar !== undefined
              ? { price: snapshot.dailyBar.c, timestamp: snapshot.dailyBar.t }
              : undefined
        if (source === undefined) return []
        const priceHalfCents = parseHalfCents(source.price)
        return priceHalfCents === undefined
          ? []
          : [{
              symbol,
              priceHalfCents,
              ...(source.timestamp === undefined
                ? {}
                : { providerTimestamp: source.timestamp }),
            }]
      })
    },

    async getOptionQuotes({ optionSymbols, feed, signal }) {
      if (optionSymbols.length === 0) return []
      const url = new URL("/v1beta1/options/snapshots", dataBaseUrl)
      url.searchParams.set("symbols", optionSymbols.join(","))
      url.searchParams.set("feed", feed)
      const parsed = optionSnapshotsSchema.safeParse(
        await get(url, signal, "option snapshots"),
      )
      if (!parsed.success) throw new Error("Alpaca option snapshots response is invalid")
      return optionSymbols.map((optionSymbol) => {
        const raw = parsed.data.snapshots[optionSymbol]?.latestQuote
        if (raw == null) {
          return collectedOptionQuoteV1Schema.parse({
            optionSymbol,
            conditions: [],
            parseStatus: "MISSING",
          })
        }
        const bidHalfCents = raw.bp == null ? undefined : parseHalfCents(raw.bp)
        const askHalfCents = raw.ap == null ? undefined : parseHalfCents(raw.ap)
        const providerTime = raw.t == null ? undefined : Date.parse(raw.t)
        const timestampValid = providerTime !== undefined && Number.isFinite(providerTime)
        const pricesValid =
          bidHalfCents !== undefined &&
          askHalfCents !== undefined &&
          bidHalfCents > 0 &&
          askHalfCents > bidHalfCents
        return collectedOptionQuoteV1Schema.parse({
          optionSymbol,
          ...(timestampValid ? { providerTimestamp: new Date(providerTime).toISOString() } : {}),
          ...(bidHalfCents === undefined ? {} : { bidHalfCents }),
          ...(askHalfCents === undefined ? {} : { askHalfCents }),
          ...(parseCount(raw.bs) === undefined ? {} : { bidSize: parseCount(raw.bs) }),
          ...(parseCount(raw.as) === undefined ? {} : { askSize: parseCount(raw.as) }),
          ...(raw.bx == null || raw.bx === "" ? {} : { bidExchange: raw.bx }),
          ...(raw.ax == null || raw.ax === "" ? {} : { askExchange: raw.ax }),
          conditions: raw.c ?? [],
          parseStatus: !timestampValid
            ? "INVALID_TIMESTAMP"
            : pricesValid
              ? "PARSED"
              : "INVALID_PRICE",
        })
      })
    },
  }
}
