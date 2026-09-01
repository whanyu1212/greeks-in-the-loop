import { z } from "zod"

import {
  ALPACA_OPTION_QUOTE_SNAPSHOT_SOURCE,
  alpacaLatestOptionQuoteSchema,
  normalizeAlpacaOptionQuote,
} from "../market-data/alpaca-option-quotes.js"
import {
  alpacaOptionEntryPlanV2Schema,
  type AlpacaOptionEntryLegV2,
  type AlpacaOptionEntryPlanV2,
} from "../options/alpaca-capabilities.js"
import { newYorkLocalTime } from "../scheduling/research-eligibility.js"
import {
  alpacaOptionStrikeCents,
  alpacaOptionSymbolSchema,
  parseAlpacaOptionSymbol,
} from "../shared/alpaca-option-identity.js"
import {
  floorNanosecondsToIsoMilliseconds,
  parseExactCents,
  parseRfc3339Nanoseconds,
} from "../shared/value-normalization.js"
import {
  contractSnapshotV2Schema,
  type ContractSnapshotV2,
  type RiskContractLegV2,
} from "./risk-evaluation-v1.js"
import {
  applicationVerifiedAccountV2Schema,
  candidateCollateralV1Schema,
  durableRiskControlStateV1Schema,
  normalizedBrokerOrderV1Schema,
  normalizedBrokerPositionV1Schema,
  reconcileBrokerPortfolioV1,
  type ApplicationRiskStateSnapshotV2,
  type ApplicationVerifiedAccountV2,
  type CandidateCollateralV1,
  type DurableRiskControlStateV1,
  type NormalizedBrokerOrderV1,
  type NormalizedBrokerPositionV1,
} from "./risk-state-v1.js"

const MAX_ORDER_PAGES = 20
const ORDER_PAGE_SIZE = 500

const captureInputSchema = z
  .object({
    sessionDate: z.iso.date(),
    slotStartedAt: z.iso.datetime({ offset: true, precision: 3 }),
    entryPlan: alpacaOptionEntryPlanV2Schema,
    durableControl: durableRiskControlStateV1Schema,
  })
  .strict()
  .superRefine((input, refinement) => {
    if (input.durableControl.tradingDate !== input.sessionDate) {
      refinement.addIssue({
        code: "custom",
        path: ["durableControl", "tradingDate"],
        message: "Durable risk state must match the capture trading date",
      })
    }
  })

const decimal = z.union([z.string(), z.number()])
const rawAccountSchema = z
  .object({
    status: z.string(),
    trading_blocked: z.boolean(),
    account_blocked: z.boolean(),
    trade_suspended_by_user: z.boolean(),
    options_approved_level: decimal.nullish(),
    options_trading_level: decimal.nullish(),
    buying_power: decimal,
    cash: decimal,
    equity: decimal,
    last_equity: decimal,
  })
  .passthrough()

const rawPositionSchema = z
  .object({
    asset_class: z.string(),
    symbol: z.string(),
    qty: decimal,
    side: z.string(),
  })
  .passthrough()

const rawOrderLegSchema = z
  .object({
    symbol: z.string(),
    qty: decimal.optional(),
    ratio_qty: decimal.optional(),
    position_intent: z.string().nullish(),
  })
  .passthrough()

const rawOrderSchema = z
  .object({
    id: z.string(),
    asset_class: z.string().min(1),
    submitted_at: z.string().nullish(),
    created_at: z.string().nullish(),
    status: z.string(),
    order_class: z.string().nullish(),
    type: z.string().nullish(),
    time_in_force: z.string().nullish(),
    qty: decimal.nullish(),
    notional: decimal.nullish(),
    position_intent: z.string().nullish(),
    legs: z.array(rawOrderLegSchema).max(4).nullish(),
  })
  .passthrough()

const rawContractSchema = z
  .object({
    symbol: z.string(),
    status: z.string(),
    tradable: z.boolean(),
    style: z.string(),
    size: decimal,
    open_interest: decimal.nullish(),
    open_interest_date: z.string().nullish(),
  })
  .passthrough()

const rawGreeksSchema = z
  .object({
    delta: decimal,
    gamma: decimal,
    theta: decimal,
    vega: decimal,
  })
  .passthrough()

const rawDailyBarSchema = z
  .object({
    t: z.string(),
    v: decimal,
  })
  .passthrough()

const fullOptionSnapshotSchema = z
  .object({
    latestQuote: alpacaLatestOptionQuoteSchema,
    greeks: rawGreeksSchema,
    impliedVolatility: decimal,
    dailyBar: rawDailyBarSchema,
  })
  .passthrough()

const partialOptionSnapshotSchema = z
  .object({
    latestQuote: alpacaLatestOptionQuoteSchema,
    greeks: rawGreeksSchema.optional(),
    impliedVolatility: decimal.optional(),
    dailyBar: rawDailyBarSchema.optional(),
  })
  .passthrough()

const rawSnapshotsResponseSchema = z
  .object({
    snapshots: z.record(z.string(), partialOptionSnapshotSchema),
  })
  .passthrough()

const rawClockSchema = z
  .object({
    timestamp: z.string(),
    is_open: z.boolean(),
  })
  .passthrough()

const MARKET_CLOCK_MAX_AGE_NANOSECONDS = 60_000_000_000n

export const RISK_STATE_CAPTURE_FAILURE_CODES = [
  "CAPTURE_INPUT_INVALID",
  "CAPTURE_TIME_INVALID",
  "CAPTURE_INTERNAL_INVALID",
  "ACCOUNT_REQUEST_FAILED",
  "ACCOUNT_RESPONSE_INVALID",
  "POSITIONS_REQUEST_FAILED",
  "POSITIONS_RESPONSE_INVALID",
  "OPEN_ORDERS_REQUEST_FAILED",
  "OPEN_ORDERS_RESPONSE_INVALID",
  "ORDER_HISTORY_REQUEST_FAILED",
  "ORDER_HISTORY_RESPONSE_INVALID",
  "ORDER_HISTORY_INCOMPLETE",
  "MARKET_CLOCK_REQUEST_FAILED",
  "MARKET_CLOCK_RESPONSE_INVALID",
  "MARKET_CLOSED",
  "CONTRACT_REQUEST_FAILED",
  "CONTRACT_RESPONSE_INVALID",
  "OPTION_SNAPSHOT_REQUEST_FAILED",
  "OPTION_SNAPSHOT_RESPONSE_INVALID",
  "OPTION_QUOTE_FROM_FUTURE",
  "OPTION_QUOTE_STALE",
  "OPTION_METRICS_UNAVAILABLE",
] as const

export type RiskStateCaptureFailureCode =
  (typeof RISK_STATE_CAPTURE_FAILURE_CODES)[number]

export type RiskStateCaptureInputV2 = Readonly<{
  sessionDate: string
  slotStartedAt: string
  entryPlan: AlpacaOptionEntryPlanV2
  durableControl: DurableRiskControlStateV1
  signal: AbortSignal
}>

export type RiskStateCaptureResultV2 =
  | Readonly<{ success: true; snapshot: ApplicationRiskStateSnapshotV2 }>
  | Readonly<{
      success: false
      reasons: readonly RiskStateCaptureFailureCode[]
    }>

export type RiskStateProvider = Readonly<{
  capture(input: RiskStateCaptureInputV2): Promise<RiskStateCaptureResultV2>
}>

export type CreateAlpacaRiskStateProviderOptions = Readonly<{
  apiKey: string
  secretKey: string
  tradingBaseUrl?: string
  dataBaseUrl?: string
  fetch?: typeof fetch
  now?: () => Date
}>

class CaptureFailure extends Error {
  constructor(readonly code: RiskStateCaptureFailureCode) {
    super(code)
    this.name = "CaptureFailure"
  }
}

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
    ) throw new Error("invalid origin")
    return url.origin
  } catch {
    throw new Error(`${setting} must be a credential-free Alpaca HTTPS URL`)
  }
}

const DECIMAL_NUMBER_PATTERN =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u

const finiteNumber = (value: unknown) => {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && DECIMAL_NUMBER_PATTERN.test(value)
      ? Number(value)
      : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

const nonnegativeInteger = (value: unknown) => {
  const parsed = finiteNumber(value)
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : undefined
}

const positiveNumber = (value: unknown) => {
  const parsed = finiteNumber(value)
  return parsed !== undefined && parsed > 0 && parsed <= Number.MAX_SAFE_INTEGER
    ? parsed
    : undefined
}

const positiveInteger = (value: unknown) => {
  const parsed = finiteNumber(value)
  return parsed !== undefined && parsed > 0 && Number.isSafeInteger(parsed)
    ? parsed
    : undefined
}

const canonicalTimestamp = (value: string) => {
  const parsed = parseRfc3339Nanoseconds(value)
  return parsed === undefined
    ? undefined
    : floorNanosecondsToIsoMilliseconds(parsed)
}

const newYorkDate = (value: string | Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(typeof value === "string" ? new Date(value) : value)

const normalizePosition = (
  raw: z.infer<typeof rawPositionSchema>,
): NormalizedBrokerPositionV1 | undefined => {
  const quantity = finiteNumber(raw.qty)
  const side = raw.side.toLowerCase()
  if (quantity === undefined || quantity === 0 || !["long", "short"].includes(side)) {
    return undefined
  }
  const absoluteQuantity = Math.abs(quantity)
  const parsed = normalizedBrokerPositionV1Schema.safeParse({
    assetClass: raw.asset_class.toLowerCase(),
    symbol: raw.symbol,
    signedQuantity: side === "long" ? absoluteQuantity : -absoluteQuantity,
  })
  return parsed.success ? parsed.data : undefined
}

const positionIntent = (value: string | null | undefined) => {
  switch (value?.toLowerCase()) {
    case "buy_to_open": return "BUY_TO_OPEN" as const
    case "sell_to_open": return "SELL_TO_OPEN" as const
    case "buy_to_close": return "BUY_TO_CLOSE" as const
    case "sell_to_close": return "SELL_TO_CLOSE" as const
    default: return "UNKNOWN" as const
  }
}

const normalizeOrder = (
  raw: z.infer<typeof rawOrderSchema>,
): NormalizedBrokerOrderV1 | undefined => {
  const submittedAt = raw.submitted_at ?? raw.created_at ?? ""
  const submittedAtNanoseconds = parseRfc3339Nanoseconds(submittedAt)
  const quantity = positiveNumber(raw.qty)
  const notional = positiveNumber(raw.notional)
  if (
    submittedAtNanoseconds === undefined ||
    (quantity === undefined && notional === undefined) ||
    raw.id.length === 0
  ) {
    return undefined
  }
  const legs = (raw.legs ?? []).map((leg) => {
    const ratioQuantity = positiveNumber(leg.ratio_qty ?? leg.qty)
    if (ratioQuantity === undefined) return undefined
    return {
      symbol: leg.symbol,
      ratioQuantity,
      positionIntent: positionIntent(leg.position_intent),
    }
  })
  if (legs.some((leg) => leg === undefined)) return undefined
  const parsed = normalizedBrokerOrderV1Schema.safeParse({
    id: raw.id,
    assetClass: raw.asset_class.toLowerCase(),
    submittedAt,
    status: raw.status.toLowerCase(),
    orderClass: (raw.order_class?.trim() || "simple").toLowerCase(),
    orderType: (raw.type ?? "unknown").toLowerCase(),
    timeInForce: (raw.time_in_force ?? "unknown").toLowerCase(),
    quantity,
    notional,
    positionIntent: positionIntent(raw.position_intent),
    legs,
  })
  return parsed.success ? parsed.data : undefined
}

const rawOrderTimestamp = (order: z.infer<typeof rawOrderSchema>) =>
  order.submitted_at ?? order.created_at ?? undefined

const normalizeAccount = (
  raw: z.infer<typeof rawAccountSchema>,
  observedAt: string,
): ApplicationVerifiedAccountV2 | undefined => {
  const buyingPowerCents = parseExactCents(raw.buying_power)
  const cashCents = parseExactCents(raw.cash)
  const equityCents = parseExactCents(raw.equity)
  const lastEquityCents = parseExactCents(raw.last_equity)
  const approvedLevel = raw.options_approved_level == null
    ? 0
    : nonnegativeInteger(raw.options_approved_level)
  const tradingLevel = raw.options_trading_level == null
    ? 0
    : nonnegativeInteger(raw.options_trading_level)
  if (
    buyingPowerCents === undefined || buyingPowerCents < 0 ||
    cashCents === undefined ||
    equityCents === undefined || equityCents < 0 ||
    lastEquityCents === undefined || lastEquityCents < 0 ||
    approvedLevel === undefined || tradingLevel === undefined
  ) return undefined
  const statusValue = raw.status.toUpperCase()
  const status = statusValue === "ACTIVE"
    ? "ACTIVE"
    : ["INACTIVE", "CLOSED", "DISABLED"].includes(statusValue)
      ? "INACTIVE"
      : "UNKNOWN"
  const parsed = applicationVerifiedAccountV2Schema.safeParse({
    snapshotVersion: "2.0.0",
    observedAt,
    status,
    tradingRestricted:
      raw.trading_blocked ||
      raw.account_blocked ||
      raw.trade_suspended_by_user,
    optionsApprovedLevel: approvedLevel,
    optionsTradingLevel: tradingLevel,
    multilegOptionsApproved: approvedLevel >= 3 && tradingLevel >= 3,
    buyingPowerCents,
    cashCents,
    equityCents,
    lastEquityCents,
  })
  return parsed.success ? parsed.data : undefined
}

const candidateCollateral = (
  entryPlan: AlpacaOptionEntryPlanV2,
  account: ApplicationVerifiedAccountV2,
  positions: readonly NormalizedBrokerPositionV1[],
): CandidateCollateralV1 | undefined => {
  const longUnderlyingShares = Math.max(0, positions
    .filter(({ assetClass, symbol }) =>
      assetClass === "us_equity" && symbol === entryPlan.underlying
    )
    .reduce((total, { signedQuantity }) => total + signedQuantity, 0))
  const requiredLongSharesPerUnit = ["COVERED_CALL", "COLLAR"].includes(
    entryPlan.strategy,
  )
    ? entryPlan.legs
      .filter(({ positionIntent, contractSymbol }) => {
        const identity = parseAlpacaOptionSymbol(contractSymbol)
        return positionIntent === "SELL_TO_OPEN" &&
          identity.success && identity.identity.optionType === "C"
      })
      .reduce((total, { ratioQuantity }) => total + ratioQuantity * 100, 0)
    : 0
  let requiredCashCentsPerUnit = 0
  if (entryPlan.strategy === "CASH_SECURED_PUT") {
    for (const leg of entryPlan.legs) {
      if (leg.positionIntent !== "SELL_TO_OPEN") continue
      const identity = parseAlpacaOptionSymbol(leg.contractSymbol)
      if (!identity.success || identity.identity.optionType !== "P") return undefined
      const strike = alpacaOptionStrikeCents(identity.identity)
      if (!strike.success) return undefined
      requiredCashCentsPerUnit +=
        strike.strikeCentsPerShare * 100 * leg.ratioQuantity
    }
  }
  const cashAvailableCents = Math.min(
    Math.max(0, account.cashCents),
    account.buyingPowerCents,
  )
  const parsed = candidateCollateralV1Schema.safeParse({
    underlying: entryPlan.underlying,
    longUnderlyingShares,
    cashAvailableCents,
    requiredLongSharesPerUnit,
    requiredCashCentsPerUnit,
    maxUnitsFromShares: requiredLongSharesPerUnit === 0
      ? null
      : Math.floor(longUnderlyingShares / requiredLongSharesPerUnit),
    maxUnitsFromCash: requiredCashCentsPerUnit === 0
      ? null
      : Math.floor(cashAvailableCents / requiredCashCentsPerUnit),
  })
  return parsed.success ? parsed.data : undefined
}

const exerciseStyle = (value: string) => {
  switch (value.toLowerCase()) {
    case "american": return "AMERICAN" as const
    case "european": return "EUROPEAN" as const
    default: return "UNKNOWN" as const
  }
}

const normalizeContractLeg = (
  entryLeg: AlpacaOptionEntryLegV2,
  contract: z.infer<typeof rawContractSchema>,
  snapshot: z.infer<typeof fullOptionSnapshotSchema>,
): RiskContractLegV2 | undefined => {
  const multiplier = positiveInteger(contract.size)
  const openInterest = nonnegativeInteger(contract.open_interest)
  const volume = nonnegativeInteger(snapshot.dailyBar.v)
  const volumeTimestamp = canonicalTimestamp(snapshot.dailyBar.t)
  const openInterestDate = z.iso.date().safeParse(contract.open_interest_date)
  const metrics = {
    delta: finiteNumber(snapshot.greeks.delta),
    gamma: finiteNumber(snapshot.greeks.gamma),
    theta: finiteNumber(snapshot.greeks.theta),
    vega: finiteNumber(snapshot.greeks.vega),
    impliedVolatility: finiteNumber(snapshot.impliedVolatility),
  }
  if (
    contract.symbol !== entryLeg.contractSymbol ||
    multiplier === undefined ||
    openInterest === undefined ||
    volume === undefined ||
    volumeTimestamp === undefined ||
    !openInterestDate.success ||
    Object.values(metrics).some((metric) => metric === undefined)
  ) return undefined
  return {
    contractSymbol: entryLeg.contractSymbol,
    positionIntent: entryLeg.positionIntent,
    ratioQuantity: entryLeg.ratioQuantity,
    active: contract.status.toLowerCase() === "active",
    tradable: contract.tradable,
    exerciseStyle: exerciseStyle(contract.style),
    multiplier,
    delta: metrics.delta!,
    impliedVolatility: metrics.impliedVolatility!,
    gamma: metrics.gamma!,
    theta: metrics.theta!,
    vega: metrics.vega!,
    volume,
    volumeDate: newYorkDate(volumeTimestamp),
    openInterest,
    openInterestDate: openInterestDate.data,
  }
}

/** Creates a coordinated, read-only Alpaca risk-state provider. */
export function createAlpacaRiskStateProvider(
  options: CreateAlpacaRiskStateProviderOptions,
): RiskStateProvider {
  const request = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
  const allowCustomHost = options.fetch !== undefined
  const tradingBaseUrl = normalizeBaseUrl(
    options.tradingBaseUrl ?? "https://paper-api.alpaca.markets",
    ["https://paper-api.alpaca.markets", "https://api.alpaca.markets"],
    allowCustomHost,
    "ALPACA_TRADING_BASE_URL",
  )
  const dataBaseUrl = normalizeBaseUrl(
    options.dataBaseUrl ?? "https://data.alpaca.markets",
    ["https://data.alpaca.markets"],
    allowCustomHost,
    "ALPACA_MARKET_DATA_BASE_URL",
  )
  const headers = {
    "APCA-API-KEY-ID": options.apiKey,
    "APCA-API-SECRET-KEY": options.secretKey,
  }

  const getJson = async (
    url: URL,
    signal: AbortSignal,
    requestFailure: RiskStateCaptureFailureCode,
    responseFailure: RiskStateCaptureFailureCode,
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
      throw new CaptureFailure(requestFailure)
    }
    if (!response.ok) throw new CaptureFailure(requestFailure)
    try {
      return await response.json() as unknown
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      throw new CaptureFailure(responseFailure)
    }
  }

  const getPositions = async (signal: AbortSignal) => {
    const raw = await getJson(
      new URL("/v2/positions", tradingBaseUrl),
      signal,
      "POSITIONS_REQUEST_FAILED",
      "POSITIONS_RESPONSE_INVALID",
    )
    const parsed = z.array(rawPositionSchema).max(10_000).safeParse(raw)
    if (!parsed.success) throw new CaptureFailure("POSITIONS_RESPONSE_INVALID")
    const normalized = parsed.data.map(normalizePosition)
    if (normalized.some((position) => position === undefined)) {
      throw new CaptureFailure("POSITIONS_RESPONSE_INVALID")
    }
    return normalized as NormalizedBrokerPositionV1[]
  }

  const getOrders = async (
    signal: AbortSignal,
    kind: "OPEN" | "HISTORY",
    historyAfter?: string,
    historyUntil?: string,
  ) => {
    const requestFailure = kind === "OPEN"
      ? "OPEN_ORDERS_REQUEST_FAILED"
      : "ORDER_HISTORY_REQUEST_FAILED"
    const responseFailure = kind === "OPEN"
      ? "OPEN_ORDERS_RESPONSE_INVALID"
      : "ORDER_HISTORY_RESPONSE_INVALID"
    const retained = new Map<string, NormalizedBrokerOrderV1>()
    let afterTimestamp = historyAfter
    for (let page = 0; page < MAX_ORDER_PAGES; page += 1) {
      const url = new URL("/v2/orders", tradingBaseUrl)
      url.searchParams.set("status", kind === "OPEN" ? "open" : "all")
      url.searchParams.set("limit", String(ORDER_PAGE_SIZE))
      url.searchParams.set("nested", "true")
      url.searchParams.set("direction", "asc")
      if (afterTimestamp !== undefined) url.searchParams.set("after", afterTimestamp)
      if (historyUntil !== undefined) url.searchParams.set("until", historyUntil)
      const raw = await getJson(url, signal, requestFailure, responseFailure)
      const parsed = z.array(rawOrderSchema).max(ORDER_PAGE_SIZE).safeParse(raw)
      if (!parsed.success) throw new CaptureFailure(responseFailure)
      const normalized = parsed.data.map(normalizeOrder)
      if (normalized.some((order) => order === undefined)) {
        throw new CaptureFailure(responseFailure)
      }
      const pageOrders = normalized as NormalizedBrokerOrderV1[]
      if (new Set(pageOrders.map(({ id }) => id)).size !== pageOrders.length) {
        throw new CaptureFailure(responseFailure)
      }
      for (const order of pageOrders) {
        const previous = retained.get(order.id)
        if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(order)) {
          throw new CaptureFailure(responseFailure)
        }
        retained.set(order.id, order)
      }
      if (parsed.data.length < ORDER_PAGE_SIZE) return [...retained.values()]
      const boundaryTimestamp = parsed.data.at(-1) === undefined
        ? undefined
        : rawOrderTimestamp(parsed.data.at(-1)!)
      const boundaryNanoseconds = boundaryTimestamp === undefined
        ? undefined
        : parseRfc3339Nanoseconds(boundaryTimestamp)
      const afterTimestampNanoseconds = afterTimestamp === undefined
        ? undefined
        : parseRfc3339Nanoseconds(afterTimestamp)
      let nextTimestamp: string | undefined
      if (boundaryNanoseconds !== undefined) {
        for (let index = parsed.data.length - 2; index >= 0; index -= 1) {
          const candidate = rawOrderTimestamp(parsed.data[index]!)
          const candidateNanoseconds = candidate === undefined
            ? undefined
            : parseRfc3339Nanoseconds(candidate)
          if (
            candidateNanoseconds !== undefined &&
            candidateNanoseconds < boundaryNanoseconds
          ) {
            nextTimestamp = candidate
            break
          }
        }
      }
      const nextTimestampNanoseconds = nextTimestamp === undefined
        ? undefined
        : parseRfc3339Nanoseconds(nextTimestamp)
      if (
        nextTimestampNanoseconds === undefined ||
        (afterTimestampNanoseconds !== undefined &&
          nextTimestampNanoseconds <= afterTimestampNanoseconds)
      ) {
        throw new CaptureFailure("ORDER_HISTORY_INCOMPLETE")
      }
      afterTimestamp = nextTimestamp
    }
    throw new CaptureFailure("ORDER_HISTORY_INCOMPLETE")
  }

  const getAccount = (signal: AbortSignal) =>
    getJson(
      new URL("/v2/account", tradingBaseUrl),
      signal,
      "ACCOUNT_REQUEST_FAILED",
      "ACCOUNT_RESPONSE_INVALID",
    )

  const getClock = (signal: AbortSignal) =>
    getJson(
      new URL("/v2/clock", tradingBaseUrl),
      signal,
      "MARKET_CLOCK_REQUEST_FAILED",
      "MARKET_CLOCK_RESPONSE_INVALID",
    )

  const getContract = (symbol: string, signal: AbortSignal) =>
    getJson(
      new URL(`/v2/options/contracts/${encodeURIComponent(symbol)}`, tradingBaseUrl),
      signal,
      "CONTRACT_REQUEST_FAILED",
      "CONTRACT_RESPONSE_INVALID",
    )

  const getSnapshots = (symbols: readonly string[], signal: AbortSignal) => {
    const url = new URL("/v1beta1/options/snapshots", dataBaseUrl)
    url.searchParams.set("symbols", symbols.join(","))
    url.searchParams.set("feed", "indicative")
    return getJson(
      url,
      signal,
      "OPTION_SNAPSHOT_REQUEST_FAILED",
      "OPTION_SNAPSHOT_RESPONSE_INVALID",
    )
  }

  return {
    async capture(input): Promise<RiskStateCaptureResultV2> {
      const parsedInput = captureInputSchema.safeParse({
        sessionDate: input.sessionDate,
        slotStartedAt: input.slotStartedAt,
        entryPlan: input.entryPlan,
        durableControl: input.durableControl,
      })
      if (!parsedInput.success) {
        return { success: false, reasons: ["CAPTURE_INPUT_INVALID"] }
      }
      const requestStartedAt = now()
      if (
        !Number.isFinite(requestStartedAt.getTime()) ||
        newYorkDate(requestStartedAt) !== parsedInput.data.sessionDate
      ) return { success: false, reasons: ["CAPTURE_TIME_INVALID"] }

      const historyAfter = new Date(
        newYorkLocalTime(parsedInput.data.sessionDate, "00:00").getTime() - 1,
      ).toISOString()
      try {
        const [initialPositions, initialOpenOrders] = await Promise.all([
          getPositions(input.signal),
          getOrders(input.signal, "OPEN"),
        ])
        const contractSymbols = parsedInput.data.entryPlan.legs.map(
          ({ contractSymbol }) => contractSymbol,
        )
        const [rawAccount, rawContracts, rawSnapshots] = await Promise.all([
          getAccount(input.signal),
          Promise.all(contractSymbols.map((symbol) =>
            getContract(symbol, input.signal)
          )),
          getSnapshots(contractSymbols, input.signal),
        ])
        const historyStartedAt = now()
        if (
          !Number.isFinite(historyStartedAt.getTime()) ||
          historyStartedAt.getTime() < requestStartedAt.getTime()
        ) {
          return { success: false, reasons: ["CAPTURE_TIME_INVALID"] }
        }
        const initialSubmittedOrders = await getOrders(
          input.signal,
          "HISTORY",
          historyAfter,
        )
        const [finalPositions, finalOpenOrders] = await Promise.all([
          getPositions(input.signal),
          getOrders(input.signal, "OPEN"),
        ])
        const evaluatedAtDate = now()
        if (
          !Number.isFinite(evaluatedAtDate.getTime()) ||
          evaluatedAtDate.getTime() < historyStartedAt.getTime()
        ) {
          return { success: false, reasons: ["CAPTURE_TIME_INVALID"] }
        }
        const evaluatedAt = evaluatedAtDate.toISOString()
        const finalSubmittedOrders = await getOrders(
          input.signal,
          "HISTORY",
          historyAfter,
          evaluatedAt,
        )
        const rawClock = await getClock(input.signal)
        const captureCompletedAt = now()
        if (
          !Number.isFinite(captureCompletedAt.getTime()) ||
          captureCompletedAt.getTime() < evaluatedAtDate.getTime()
        ) {
          return { success: false, reasons: ["CAPTURE_TIME_INVALID"] }
        }

        const clock = rawClockSchema.safeParse(rawClock)
        if (!clock.success) {
          throw new CaptureFailure("MARKET_CLOCK_RESPONSE_INVALID")
        }
        const clockTimestampNanoseconds = parseRfc3339Nanoseconds(
          clock.data.timestamp,
        )
        const captureCompletedAtNanoseconds =
          BigInt(captureCompletedAt.getTime()) * 1_000_000n
        if (
          clockTimestampNanoseconds === undefined ||
          clockTimestampNanoseconds > captureCompletedAtNanoseconds ||
          captureCompletedAtNanoseconds - clockTimestampNanoseconds >
            MARKET_CLOCK_MAX_AGE_NANOSECONDS ||
          newYorkDate(clock.data.timestamp) !== parsedInput.data.sessionDate
        ) {
          throw new CaptureFailure("MARKET_CLOCK_RESPONSE_INVALID")
        }
        if (!clock.data.is_open) throw new CaptureFailure("MARKET_CLOSED")

        const accountRaw = rawAccountSchema.safeParse(rawAccount)
        if (!accountRaw.success) throw new CaptureFailure("ACCOUNT_RESPONSE_INVALID")
        const account = normalizeAccount(
          accountRaw.data,
          requestStartedAt.toISOString(),
        )
        if (account === undefined) throw new CaptureFailure("ACCOUNT_RESPONSE_INVALID")
        const collateral = candidateCollateral(
          parsedInput.data.entryPlan,
          account,
          finalPositions,
        )
        if (collateral === undefined) {
          throw new CaptureFailure("ACCOUNT_RESPONSE_INVALID")
        }

        const parsedContracts = rawContracts.map((raw) =>
          rawContractSchema.safeParse(raw)
        )
        if (parsedContracts.some((contract) => !contract.success)) {
          throw new CaptureFailure("CONTRACT_RESPONSE_INVALID")
        }
        const snapshotsRaw = rawSnapshotsResponseSchema.safeParse(rawSnapshots)
        if (!snapshotsRaw.success) {
          throw new CaptureFailure("OPTION_SNAPSHOT_RESPONSE_INVALID")
        }
        const parsedSnapshots = contractSymbols.map((symbol) => {
          const snapshot = snapshotsRaw.data.snapshots[symbol]
          return snapshot === undefined
            ? undefined
            : fullOptionSnapshotSchema.safeParse(snapshot)
        })
        if (
          parsedSnapshots.some((snapshot) =>
            snapshot === undefined || !snapshot.success
          )
        ) {
          throw new CaptureFailure("OPTION_METRICS_UNAVAILABLE")
        }
        const snapshots = parsedSnapshots.flatMap((snapshot) =>
          snapshot?.success ? [snapshot.data] : []
        )
        if (snapshots.length !== contractSymbols.length) {
          throw new CaptureFailure("OPTION_METRICS_UNAVAILABLE")
        }
        const evaluatedAtNanoseconds = BigInt(evaluatedAtDate.getTime()) * 1_000_000n
        const normalizedQuotes = contractSymbols.map((symbol, index) =>
          normalizeAlpacaOptionQuote(
            symbol,
            snapshots[index]!.latestQuote,
            captureCompletedAtNanoseconds,
          )
        )
        for (const quote of normalizedQuotes) {
          if (!quote.success) {
            if (quote.reason === "QUOTE_FROM_FUTURE") {
              throw new CaptureFailure("OPTION_QUOTE_FROM_FUTURE")
            }
            if (quote.reason === "QUOTE_STALE") {
              throw new CaptureFailure("OPTION_QUOTE_STALE")
            }
            throw new CaptureFailure("OPTION_SNAPSHOT_RESPONSE_INVALID")
          }
        }
        const successfulQuotes = normalizedQuotes.flatMap((quote) =>
          quote.success ? [quote] : []
        )
        if (successfulQuotes.length !== contractSymbols.length) {
          throw new CaptureFailure("OPTION_SNAPSHOT_RESPONSE_INVALID")
        }
        const contractLegs = parsedInput.data.entryPlan.legs.map((entryLeg, index) => {
          const contract = parsedContracts[index]!
          if (!contract.success) return undefined
          return normalizeContractLeg(entryLeg, contract.data, snapshots[index]!)
        })
        if (contractLegs.some((leg) => leg === undefined)) {
          throw new CaptureFailure("OPTION_METRICS_UNAVAILABLE")
        }
        const contracts = contractSnapshotV2Schema.safeParse({
          snapshotVersion: "2.0.0",
          slotStartedAt: parsedInput.data.slotStartedAt,
          observedAt: evaluatedAt,
          legs: contractLegs,
        })
        if (!contracts.success) throw new CaptureFailure("CONTRACT_RESPONSE_INVALID")

        const requestStartedAtNanoseconds =
          BigInt(requestStartedAt.getTime()) * 1_000_000n
        const stableOrders = (orders: readonly NormalizedBrokerOrderV1[]) =>
          JSON.stringify([...orders].sort((left, right) =>
            left.id.localeCompare(right.id),
          ))
        const orderHistoryChangedDuringCapture =
          stableOrders(initialSubmittedOrders) !== stableOrders(finalSubmittedOrders)
        const submittedOrderById = new Map(
          initialSubmittedOrders.map((order) => [order.id, order]),
        )
        for (const order of finalSubmittedOrders) submittedOrderById.set(order.id, order)
        const submittedOrders = [...submittedOrderById.values()]
        if (submittedOrders.some(({ submittedAt }) =>
          parseRfc3339Nanoseconds(submittedAt)! > evaluatedAtNanoseconds
        )) {
          throw new CaptureFailure("ORDER_HISTORY_RESPONSE_INVALID")
        }
        const currentDateOrders = submittedOrders.filter(({ submittedAt }) => {
          const submittedAtNanoseconds = parseRfc3339Nanoseconds(submittedAt)
          return submittedAtNanoseconds !== undefined &&
            newYorkDate(submittedAt) === parsedInput.data.sessionDate &&
            submittedAtNanoseconds <= evaluatedAtNanoseconds
        })
        const brokerStateChangedDuringCapture =
          orderHistoryChangedDuringCapture ||
          currentDateOrders.some(
            ({ submittedAt }) =>
              parseRfc3339Nanoseconds(submittedAt)! > requestStartedAtNanoseconds,
          )
        const reconciliation = reconcileBrokerPortfolioV1({
          observedAt: evaluatedAt,
          sessionDate: parsedInput.data.sessionDate,
          durableControl: parsedInput.data.durableControl,
          account: {
            equityCents: account.equityCents,
            lastEquityCents: account.lastEquityCents,
          },
          initialBrokerState: {
            positions: initialPositions,
            openOrders: initialOpenOrders,
          },
          finalBrokerState: {
            positions: finalPositions,
            openOrders: finalOpenOrders,
          },
          submittedOrders: currentDateOrders,
          brokerStateChangedDuringCapture,
        })
        if (!reconciliation.success) {
          return { success: false, reasons: ["CAPTURE_INPUT_INVALID"] }
        }
        const shareCollateralExplainsPositions =
          collateral.requiredLongSharesPerUnit > 0 &&
          (collateral.maxUnitsFromShares ?? 0) >= 1 &&
          finalPositions.length > 0 &&
          finalPositions.every(({ assetClass, symbol, signedQuantity }) =>
            assetClass === "us_equity" &&
            symbol === parsedInput.data.entryPlan.underlying &&
            signedQuantity > 0
          ) &&
          reconciliation.reasonCodes.every((reason) =>
            reason === "UNKNOWN_POSITION"
          )
        const reconciliationReasonCodes = shareCollateralExplainsPositions
          ? []
          : reconciliation.reasonCodes
        const portfolio = shareCollateralExplainsPositions
          ? { ...reconciliation.portfolio, consistent: true }
          : reconciliation.portfolio
        const freshUntilNanoseconds = successfulQuotes.reduce(
          (earliest, quote) =>
            quote.freshUntilNanoseconds < earliest
              ? quote.freshUntilNanoseconds
              : earliest,
          successfulQuotes[0]!.freshUntilNanoseconds,
        )
        return {
          success: true,
          snapshot: {
            snapshotVersion: "2.0.0",
            evaluatedAt,
            quoteSnapshot: {
              snapshotVersion: "2.0.0",
              evaluatedAt,
              snapshotMetadata: {
                provider: "ALPACA",
                source: ALPACA_OPTION_QUOTE_SNAPSHOT_SOURCE,
                retrievedAt: evaluatedAt,
                freshUntil: floorNanosecondsToIsoMilliseconds(
                  freshUntilNanoseconds,
                ),
              },
              quotes: successfulQuotes.map(({ quote }) => quote),
            },
            account,
            positions: finalPositions,
            candidateCollateral: collateral,
            portfolio,
            contracts: contracts.data as ContractSnapshotV2,
            reconciliationReasonCodes,
          },
        }
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason ?? error
        if (error instanceof CaptureFailure) {
          return { success: false, reasons: [error.code] }
        }
        return { success: false, reasons: ["CAPTURE_INTERNAL_INVALID"] }
      }
    },
  }
}
