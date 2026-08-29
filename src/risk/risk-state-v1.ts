import { z } from "zod"

import type { ConfirmedOptionQuoteSnapshotV1 } from "../market-data/alpaca-option-quotes.js"
import {
  parseAlpacaOptionSymbol,
  spyAlpacaOptionSymbolV1Schema,
  validateSpyOptionUniverseV1,
} from "../shared/alpaca-option-identity.js"
import {
  applicationVerifiedAccountV1Schema,
  reconciledPortfolioV1Schema,
  type ApplicationVerifiedAccountV1,
  type ContractSnapshotV1,
  type ReconciledPortfolioV1,
} from "./risk-evaluation-v1.js"

export const DURABLE_RISK_CONTROL_STATE_VERSION = "1.0.0" as const

const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const providerTimestamp = z.iso.datetime({ offset: true })
const boundedCount = z.number().int().nonnegative().max(1_000_000)
const finiteProviderNumber = z
  .number()
  .finite()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
const positiveProviderNumber = z
  .number()
  .finite()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
const brokerIdentifier = z.string().min(1).max(128)
const optionSymbol = spyAlpacaOptionSymbolV1Schema

export const durableRiskControlStateV1Schema = z
  .object({
    stateVersion: z.literal(DURABLE_RISK_CONTROL_STATE_VERSION),
    tradingDate: z.iso.date(),
    entriesSubmittedToday: boundedCount,
    dailyBreakerActive: z.boolean(),
    competitionBreakerActive: z.boolean(),
  })
  .strict()

export type DurableRiskControlStateV1 = Readonly<
  z.infer<typeof durableRiskControlStateV1Schema>
>

export const normalizedBrokerPositionV1Schema = z
  .object({
    assetClass: z.string().min(1).max(64),
    symbol: z.string().min(1).max(64),
    signedQuantity: finiteProviderNumber,
  })
  .strict()

export const BROKER_POSITION_INTENTS = [
  "BUY_TO_OPEN",
  "SELL_TO_OPEN",
  "BUY_TO_CLOSE",
  "SELL_TO_CLOSE",
  "UNKNOWN",
] as const

export const normalizedBrokerOrderLegV1Schema = z
  .object({
    symbol: z.string().min(1).max(64),
    ratioQuantity: positiveProviderNumber,
    positionIntent: z.enum(BROKER_POSITION_INTENTS),
  })
  .strict()

export const normalizedBrokerOrderV1Schema = z
  .object({
    id: brokerIdentifier,
    assetClass: z.string().min(1).max(64),
    submittedAt: providerTimestamp,
    status: z.string().min(1).max(64),
    orderClass: z.string().min(1).max(64),
    orderType: z.string().min(1).max(64),
    timeInForce: z.string().min(1).max(64),
    quantity: positiveProviderNumber.optional(),
    notional: positiveProviderNumber.optional(),
    positionIntent: z.enum(BROKER_POSITION_INTENTS).optional(),
    legs: z.array(normalizedBrokerOrderLegV1Schema).max(4),
  })
  .strict()
  .refine(
    ({ quantity, notional }) => quantity !== undefined || notional !== undefined,
    { message: "Broker order requires quantity or notional" },
  )

export type NormalizedBrokerPositionV1 = Readonly<
  z.infer<typeof normalizedBrokerPositionV1Schema>
>
export type NormalizedBrokerOrderV1 = Readonly<
  z.infer<typeof normalizedBrokerOrderV1Schema>
>

const brokerStateSchema = z
  .object({
    positions: z.array(normalizedBrokerPositionV1Schema).max(10_000),
    openOrders: z.array(normalizedBrokerOrderV1Schema).max(10_000),
  })
  .strict()

export const RISK_RECONCILIATION_REASON_CODES = [
  "BROKER_STATE_CHANGED",
  "DUPLICATE_BROKER_RECORD",
  "UNKNOWN_POSITION",
  "UNMATCHED_OPTION_POSITION",
  "MULTIPLE_STRATEGY_POSITIONS",
  "UNKNOWN_OPEN_ORDER",
  "UNMATCHED_PENDING_ENTRY",
  "MULTIPLE_PENDING_ENTRIES",
] as const

export type RiskReconciliationReasonCode =
  (typeof RISK_RECONCILIATION_REASON_CODES)[number]

const reconciliationInputSchema = z
  .object({
    observedAt: timestamp,
    sessionDate: z.iso.date(),
    durableControl: durableRiskControlStateV1Schema,
    account: applicationVerifiedAccountV1Schema.pick({
      equityCents: true,
      lastEquityCents: true,
    }),
    initialBrokerState: brokerStateSchema,
    finalBrokerState: brokerStateSchema,
    submittedOrders: z.array(normalizedBrokerOrderV1Schema).max(10_000),
    brokerStateChangedDuringCapture: z.boolean().optional().default(false),
  })
  .strict()

export type ReconcileBrokerPortfolioV1Input = Readonly<
  z.infer<typeof reconciliationInputSchema>
>

export type ReconcileBrokerPortfolioV1Result =
  | Readonly<{
      success: true
      portfolio: ReconciledPortfolioV1
      reasonCodes: readonly RiskReconciliationReasonCode[]
    }>
  | Readonly<{
      success: false
      reasons: readonly ["RECONCILIATION_INPUT_INVALID"]
    }>

const isSupportedSpread = (
  longSymbol: string,
  shortSymbol: string,
) => {
  const long = parseAlpacaOptionSymbol(longSymbol)
  const short = parseAlpacaOptionSymbol(shortSymbol)
  if (
    !long.success ||
    !short.success ||
    !validateSpyOptionUniverseV1(long.identity).success ||
    !validateSpyOptionUniverseV1(short.identity).success ||
    long.identity.expiration !== short.identity.expiration ||
    long.identity.optionType !== short.identity.optionType
  ) return false
  return long.identity.optionType === "C"
    ? long.identity.strikeThousandthsPerShare <
        short.identity.strikeThousandthsPerShare
    : long.identity.strikeThousandthsPerShare >
        short.identity.strikeThousandthsPerShare
}

const stableBrokerState = (state: z.infer<typeof brokerStateSchema>) =>
  JSON.stringify({
    positions: [...state.positions].sort((left, right) =>
      left.symbol.localeCompare(right.symbol) ||
      left.signedQuantity - right.signedQuantity),
    openOrders: [...state.openOrders]
      .map((order) => ({
        ...order,
        legs: [...order.legs].sort((left, right) =>
          left.symbol.localeCompare(right.symbol)),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  })

const hasDuplicate = <T>(values: readonly T[], key: (value: T) => string) => {
  const keys = values.map(key)
  return new Set(keys).size !== keys.length
}

const classifyPositions = (
  positions: readonly NormalizedBrokerPositionV1[],
  addReason: (reason: RiskReconciliationReasonCode) => void,
) => {
  if (positions.length === 0) return 0
  if (positions.some(({ assetClass }) => assetClass !== "us_option")) {
    addReason("UNKNOWN_POSITION")
  }
  const optionPositions = positions.filter(
    ({ assetClass }) => assetClass === "us_option",
  )
  if (
    optionPositions.some(
      ({ symbol, signedQuantity }) =>
        !optionSymbol.safeParse(symbol).success ||
        !Number.isInteger(signedQuantity) ||
        Math.abs(signedQuantity) !== 1,
    )
  ) addReason("UNMATCHED_OPTION_POSITION")
  if (optionPositions.length > 2) addReason("MULTIPLE_STRATEGY_POSITIONS")
  if (optionPositions.length !== 2) {
    if (optionPositions.length > 0) addReason("UNMATCHED_OPTION_POSITION")
    return optionPositions.length === 0 ? 0 : 1
  }
  const long = optionPositions.find(({ signedQuantity }) => signedQuantity === 1)
  const short = optionPositions.find(({ signedQuantity }) => signedQuantity === -1)
  if (
    long === undefined ||
    short === undefined ||
    !isSupportedSpread(long.symbol, short.symbol)
  ) {
    addReason("UNMATCHED_OPTION_POSITION")
  }
  return 1
}

const isSupportedOpeningOrder = (order: NormalizedBrokerOrderV1) => {
  if (
    order.assetClass !== "us_option" ||
    order.orderClass !== "mleg" ||
    order.orderType !== "limit" ||
    order.timeInForce !== "day" ||
    order.quantity !== 1 ||
    order.legs.length !== 2
  ) return false
  const long = order.legs.find(
    ({ positionIntent }) => positionIntent === "BUY_TO_OPEN",
  )
  const short = order.legs.find(
    ({ positionIntent }) => positionIntent === "SELL_TO_OPEN",
  )
  return (
    long !== undefined &&
    short !== undefined &&
    long.ratioQuantity === 1 &&
    short.ratioQuantity === 1 &&
    isSupportedSpread(long.symbol, short.symbol)
  )
}

const CLOSING_POSITION_INTENTS = new Set([
  "BUY_TO_CLOSE",
  "SELL_TO_CLOSE",
])

const isRecognizedClosingOnlyOrder = (order: NormalizedBrokerOrderV1) =>
  order.assetClass === "us_option" &&
  (order.legs.length > 0
    ? order.legs.every(({ positionIntent }) =>
      CLOSING_POSITION_INTENTS.has(positionIntent),
    )
    : CLOSING_POSITION_INTENTS.has(order.positionIntent ?? "UNKNOWN"))

const OPEN_ORDER_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "accepted_for_bidding",
  "partially_filled",
  "held",
  "pending_replace",
  "pending_cancel",
  "stopped",
  "calculated",
])

const classifyOpenOrders = (
  orders: readonly NormalizedBrokerOrderV1[],
  addReason: (reason: RiskReconciliationReasonCode) => void,
) => {
  if (orders.length === 0) return 0
  const supported = orders.filter(
    (order) =>
      OPEN_ORDER_STATUSES.has(order.status) && isSupportedOpeningOrder(order),
  )
  if (supported.length !== orders.length) addReason("UNKNOWN_OPEN_ORDER")
  if (supported.length === 0) addReason("UNMATCHED_PENDING_ENTRY")
  if (orders.length > 1) addReason("MULTIPLE_PENDING_ENTRIES")
  return orders.length
}

/** Reconciles normalized, read-only broker observations into the risk input. */
export function reconcileBrokerPortfolioV1(
  input: unknown,
): ReconcileBrokerPortfolioV1Result {
  const parsed = reconciliationInputSchema.safeParse(input)
  if (!parsed.success || parsed.data.durableControl.tradingDate !== parsed.data.sessionDate) {
    return { success: false, reasons: ["RECONCILIATION_INPUT_INVALID"] }
  }
  const {
    observedAt,
    durableControl,
    account,
    initialBrokerState,
    finalBrokerState,
    submittedOrders,
    brokerStateChangedDuringCapture,
  } = parsed.data
  const reasonSet = new Set<RiskReconciliationReasonCode>()
  const addReason = (reason: RiskReconciliationReasonCode) => reasonSet.add(reason)

  if (
    brokerStateChangedDuringCapture ||
    stableBrokerState(initialBrokerState) !== stableBrokerState(finalBrokerState)
  ) {
    addReason("BROKER_STATE_CHANGED")
  }
  if (
    hasDuplicate(finalBrokerState.positions, ({ symbol }) => symbol) ||
    hasDuplicate(finalBrokerState.openOrders, ({ id }) => id) ||
    hasDuplicate(submittedOrders, ({ id }) => id)
  ) addReason("DUPLICATE_BROKER_RECORD")

  const openStrategyPositionCount = classifyPositions(
    finalBrokerState.positions,
    addReason,
  )
  const pendingEntryCount = classifyOpenOrders(
    finalBrokerState.openOrders,
    addReason,
  )
  const submittedEntryCount = new Set(
    submittedOrders
      .filter(
        (order) =>
          isSupportedOpeningOrder(order) ||
          (order.assetClass === "us_option" &&
            !isRecognizedClosingOnlyOrder(order)),
      )
      .map(({ id }) => id),
  ).size
  const reasonCodes = RISK_RECONCILIATION_REASON_CODES.filter((reason) =>
    reasonSet.has(reason),
  )
  const portfolio = reconciledPortfolioV1Schema.parse({
    observedAt,
    consistent: reasonCodes.length === 0,
    openStrategyPositionCount,
    pendingEntryCount,
    entriesSubmittedToday: Math.max(
      durableControl.entriesSubmittedToday,
      submittedEntryCount,
    ),
    dailyBreakerActive:
      durableControl.dailyBreakerActive ||
      account.lastEquityCents - account.equityCents >= 150_000,
    competitionBreakerActive:
      durableControl.competitionBreakerActive ||
      account.equityCents <= 9_250_000,
  })
  return { success: true, portfolio, reasonCodes }
}

export type ApplicationRiskStateSnapshotV1 = Readonly<{
  evaluatedAt: string
  quoteSnapshot: ConfirmedOptionQuoteSnapshotV1
  account: ApplicationVerifiedAccountV1
  portfolio: ReconciledPortfolioV1
  contracts: ContractSnapshotV1
  reconciliationReasonCodes: readonly RiskReconciliationReasonCode[]
}>
