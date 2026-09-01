import { z } from "zod"

import {
  OPTION_UNIVERSE_POLICY_VERSION,
  OPTION_UNIVERSE_SNAPSHOT_VERSION,
  DISCOVERY_POOL_LIMIT,
  RESEARCH_SHORTLIST_LIMIT,
  optionUniverseCandidateV2Schema,
  optionUniverseSnapshotV2Schema,
  type OptionUniverseSnapshotV2,
} from "../contracts/option-universe-v2.js"
import { canonicalJsonSha256 } from "../shared/canonical-json.js"
import { optionUnderlyingV1Schema } from "../shared/alpaca-option-identity.js"

const MAX_CONTRACT_PAGES = 5
const LIQUID_OPEN_INTEREST = 500
const providerSymbol = z.string().trim().min(1).max(32)

export type OptionUniverseProvider = Readonly<{
  discover(
    sessionDate: string,
    signal: AbortSignal,
  ): Promise<OptionUniverseSnapshotV2>
}>

export type AlpacaOptionUniverseProviderOptions = Readonly<{
  apiKey: string
  secretKey: string
  dataBaseUrl?: string
  tradingBaseUrl?: string
  fetch?: typeof fetch
  now?: () => Date
}>

const assetSchema = z
  .object({
    symbol: providerSymbol,
    status: z.string(),
    tradable: z.boolean(),
    attributes: z.array(z.string()).nullish(),
  })
  .passthrough()

const activeSchema = z
  .object({ symbol: providerSymbol })
  .passthrough()

const mostActivesSchema = z
  .object({ most_actives: z.array(activeSchema).max(100) })
  .passthrough()

const moverSchema = z
  .object({
    symbol: providerSymbol,
    percent_change: z.union([z.number(), z.string()]),
  })
  .passthrough()

const moversSchema = z
  .object({
    gainers: z.array(moverSchema).max(50),
    losers: z.array(moverSchema).max(50),
  })
  .passthrough()

const optionContractSchema = z
  .object({
    underlying_symbol: providerSymbol,
    expiration_date: z.iso.date(),
    status: z.string(),
    tradable: z.boolean(),
    type: z.enum(["call", "put"]),
    style: z.string(),
    strike_price: z.union([z.number(), z.string()]),
    size: z.union([z.number(), z.string()]),
    open_interest: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough()

const optionContractsSchema = z
  .object({
    option_contracts: z.array(optionContractSchema),
    next_page_token: z.string().min(1).nullable().optional(),
  })
  .passthrough()

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
    ) {
      throw new Error("invalid origin")
    }
    return url.origin
  } catch {
    throw new Error(`${setting} must be a credential-free Alpaca HTTPS URL`)
  }
}

const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(value.getTime())) throw new Error("Session date is invalid")
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

const providerNumber = (value: number | string) => {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const snapshot = (
  sessionDate: string,
  generatedAt: string,
  candidates: z.infer<typeof optionUniverseCandidateV2Schema>[],
) => {
  const content = {
    snapshotVersion: OPTION_UNIVERSE_SNAPSHOT_VERSION,
    policyVersion: OPTION_UNIVERSE_POLICY_VERSION,
    generatedAt,
    sessionDate,
    source: "ALPACA_OPTIONS_SCREENERS" as const,
    candidates,
  }
  return optionUniverseSnapshotV2Schema.parse({
    ...content,
    snapshotId: `option-universe-v2-${canonicalJsonSha256(content)}`,
  })
}

/** Builds a bounded, high-activity, optionable shortlist from Alpaca data. */
export function createAlpacaOptionUniverseProvider(
  options: AlpacaOptionUniverseProviderOptions,
): OptionUniverseProvider {
  const request = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
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

  const get = async (url: URL, signal: AbortSignal) => {
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
      throw new Error("Alpaca option-universe request failed")
    }
    if (!response.ok) throw new Error("Alpaca option-universe request failed")
    try {
      return await response.json() as unknown
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      throw new Error("Alpaca option-universe response is invalid")
    }
  }

  return {
    async discover(sessionDate, signal) {
      signal.throwIfAborted()
      if (!z.iso.date().safeParse(sessionDate).success) {
        throw new Error("Session date is invalid")
      }

      const assetsUrl = new URL("/v2/assets", tradingBaseUrl)
      assetsUrl.searchParams.set("status", "active")
      assetsUrl.searchParams.set("asset_class", "us_equity")
      assetsUrl.searchParams.set("attributes", "has_options")
      const activesUrl = new URL(
        "/v1beta1/screener/stocks/most-actives",
        dataBaseUrl,
      )
      activesUrl.searchParams.set("by", "trades")
      activesUrl.searchParams.set("top", "100")
      const moversUrl = new URL(
        "/v1beta1/screener/stocks/movers",
        dataBaseUrl,
      )
      moversUrl.searchParams.set("top", "50")

      const [rawAssets, rawActives, rawMovers] = await Promise.all([
        get(assetsUrl, signal),
        get(activesUrl, signal),
        get(moversUrl, signal),
      ])
      const assets = z.array(assetSchema).safeParse(rawAssets)
      const actives = mostActivesSchema.safeParse(rawActives)
      const movers = moversSchema.safeParse(rawMovers)
      if (!assets.success || !actives.success || !movers.success) {
        throw new Error("Alpaca option-universe response is invalid")
      }

      const optionable = new Set(
        assets.data
          .filter(({ symbol, status, tradable, attributes }) =>
            status === "active" &&
            tradable &&
            attributes?.includes("has_options") === true &&
            optionUnderlyingV1Schema.safeParse(symbol).success)
          .map(({ symbol }) => symbol),
      )
      const changes = new Map<string, number>()
      for (const mover of [...movers.data.gainers, ...movers.data.losers]) {
        const change = providerNumber(mover.percent_change)
        if (change !== undefined) changes.set(mover.symbol, change)
      }
      const discovered = new Map<string, {
        underlying: string
        activityRank?: number
        sessionPercentChange?: number
      }>()
      actives.data.most_actives.forEach(({ symbol }, index) => {
        if (!optionable.has(symbol)) return
        const sessionPercentChange = changes.get(symbol)
        discovered.set(symbol, {
          underlying: symbol,
          activityRank: index + 1,
          ...(sessionPercentChange === undefined
            ? {}
            : { sessionPercentChange }),
        })
      })
      for (const mover of [...movers.data.gainers, ...movers.data.losers]) {
        if (!optionable.has(mover.symbol)) continue
        const sessionPercentChange = changes.get(mover.symbol)
        const existing = discovered.get(mover.symbol)
        discovered.set(mover.symbol, {
          underlying: mover.symbol,
          ...(existing?.activityRank === undefined
            ? {}
            : { activityRank: existing.activityRank }),
          ...(sessionPercentChange === undefined
            ? {}
            : { sessionPercentChange }),
        })
      }
      const screened = [...discovered.values()]
        .sort((left, right) =>
          Number(right.sessionPercentChange !== undefined) -
            Number(left.sessionPercentChange !== undefined) ||
          Math.abs(right.sessionPercentChange ?? 0) -
            Math.abs(left.sessionPercentChange ?? 0) ||
          (left.activityRank ?? DISCOVERY_POOL_LIMIT + 1) -
            (right.activityRank ?? DISCOVERY_POOL_LIMIT + 1) ||
          left.underlying.localeCompare(right.underlying),
        )
        .slice(0, DISCOVERY_POOL_LIMIT)

      if (screened.length === 0) {
        return snapshot(sessionDate, now().toISOString(), [])
      }

      const contractsUrl = new URL("/v2/options/contracts", tradingBaseUrl)
      contractsUrl.searchParams.set(
        "underlying_symbols",
        screened.map(({ underlying }) => underlying).join(","),
      )
      contractsUrl.searchParams.set("status", "active")
      contractsUrl.searchParams.set("style", "american")
      contractsUrl.searchParams.set("expiration_date_gte", addDays(sessionDate, 14))
      contractsUrl.searchParams.set("expiration_date_lte", addDays(sessionDate, 30))
      contractsUrl.searchParams.set("limit", "10000")

      const contractsBySeries = new Map<string, Map<number, number | undefined>>()
      for (let page = 0; page < MAX_CONTRACT_PAGES; page += 1) {
        const parsed = optionContractsSchema.safeParse(
          await get(contractsUrl, signal),
        )
        if (!parsed.success) {
          throw new Error("Alpaca option-universe response is invalid")
        }
        for (const contract of parsed.data.option_contracts) {
          if (
            contract.status !== "active" ||
            !contract.tradable ||
            contract.style !== "american"
          ) continue
          const strike = providerNumber(contract.strike_price)
          const size = providerNumber(contract.size)
          if (strike === undefined || strike <= 0 || size !== 100) continue
          const key = [
            contract.underlying_symbol,
            contract.expiration_date,
            contract.type,
          ].join("|")
          const openInterest = contract.open_interest == null
            ? undefined
            : providerNumber(contract.open_interest)
          const contracts = contractsBySeries.get(key) ?? new Map()
          contracts.set(
            strike,
            openInterest !== undefined && Number.isInteger(openInterest) &&
                openInterest >= 0
              ? openInterest
              : undefined,
          )
          contractsBySeries.set(key, contracts)
        }
        const pageToken = parsed.data.next_page_token
        if (pageToken === undefined || pageToken === null) break
        if (page === MAX_CONTRACT_PAGES - 1) {
          throw new Error("Alpaca option-universe contract result is too large")
        }
        contractsUrl.searchParams.set("page_token", pageToken)
      }

      const liquidityByUnderlying = new Map<string, {
        expirationCount: number
        viableSeriesCount: number
        liquidSeriesCount: number
        contractCount: number
        liquidContractCount: number
        totalOpenInterest: number
        openInterestCoverage: number
      }>()
      for (const candidate of screened) {
        const series = [...contractsBySeries].filter(([key]) =>
          key.startsWith(`${candidate.underlying}|`)
        )
        const viableSeries = series.filter(([, contracts]) => contracts.size >= 2)
        const liquidSeries = viableSeries.filter(([, contracts]) =>
          [...contracts.values()].filter(
            (openInterest) =>
              openInterest !== undefined && openInterest >= LIQUID_OPEN_INTEREST,
          ).length >= 2
        )
        const contracts = series.flatMap(([, values]) => [...values.values()])
        const observedOpenInterest = contracts.filter(
          (value): value is number => value !== undefined,
        )
        const liquidContractCount = observedOpenInterest.filter(
          (value) => value >= LIQUID_OPEN_INTEREST,
        ).length
        if (viableSeries.length === 0 || liquidSeries.length === 0) continue
        liquidityByUnderlying.set(candidate.underlying, {
          expirationCount: new Set(
            viableSeries.map(([key]) => key.split("|")[1]!),
          ).size,
          viableSeriesCount: viableSeries.length,
          liquidSeriesCount: liquidSeries.length,
          contractCount: contracts.length,
          liquidContractCount,
          totalOpenInterest: observedOpenInterest.reduce(
            (total, value) => total + value,
            0,
          ),
          openInterestCoverage: observedOpenInterest.length / contracts.length,
        })
      }
      const candidates = screened
        .flatMap((candidate) => {
          const optionLiquidity = liquidityByUnderlying.get(candidate.underlying)
          return optionLiquidity === undefined
            ? []
            : [{ ...candidate, optionLiquidity }]
        })
        .sort((left, right) =>
          right.optionLiquidity.liquidSeriesCount -
            left.optionLiquidity.liquidSeriesCount ||
          right.optionLiquidity.liquidContractCount -
            left.optionLiquidity.liquidContractCount ||
          right.optionLiquidity.totalOpenInterest -
            left.optionLiquidity.totalOpenInterest ||
          Math.abs(right.sessionPercentChange ?? 0) -
            Math.abs(left.sessionPercentChange ?? 0) ||
          (left.activityRank ?? DISCOVERY_POOL_LIMIT + 1) -
            (right.activityRank ?? DISCOVERY_POOL_LIMIT + 1) ||
          left.underlying.localeCompare(right.underlying),
        )
        .slice(0, RESEARCH_SHORTLIST_LIMIT)
        .map((candidate, index) => ({
          rank: index + 1,
          underlying: candidate.underlying,
          ...(candidate.activityRank === undefined
            ? {}
            : { activityRank: candidate.activityRank }),
          optionLiquidity: candidate.optionLiquidity,
          ...(candidate.sessionPercentChange === undefined
            ? {}
            : { sessionPercentChange: candidate.sessionPercentChange }),
        }))
      return snapshot(sessionDate, now().toISOString(), candidates)
    },
  }
}
