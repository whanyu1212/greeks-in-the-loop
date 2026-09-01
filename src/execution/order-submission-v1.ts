import { z } from "zod"

import { type TradeIntentV4 } from "../contracts/trade-intent-v4.js"
import { alpacaOptionSymbolSchema } from "../shared/alpaca-option-identity.js"

/**
 * Pure derivation of one broker order request from an approved trade intent.
 *
 * Nothing here performs I/O. The request body is a total function of the
 * intent that already passed `evaluateTradeIntentRiskV1`, so the exact order
 * that reaches the broker is reproducible from the ledger alone.
 */

export const ORDER_SUBMISSION_VERSION = "1.0.0" as const

/** Only one contract per approved intent; risk rule 1.1.0 approves quantity 1. */
export const APPROVED_ORDER_QUANTITY = 1 as const

/** Day orders only: the entry window closes with the session. */
export const ORDER_TIME_IN_FORCE = "day" as const

export const ORDER_TERMINAL_REJECTION_CODES = [
  "BROKER_REJECTED",
  "BROKER_REQUEST_FAILED",
  "BROKER_RESPONSE_INVALID",
  "ORDER_EXPIRED",
  "ORDER_CANCELED",
  "SUBMISSION_ABANDONED",
] as const
export type OrderTerminalRejectionCode =
  (typeof ORDER_TERMINAL_REJECTION_CODES)[number]

const centsToDecimalString = (cents: number) => {
  const sign = cents < 0 ? "-" : ""
  const absolute = Math.abs(cents)
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`
}

export type AlpacaMlegOrderRequestV1 = Readonly<{
  order_class: "mleg"
  qty: string
  type: "limit"
  time_in_force: typeof ORDER_TIME_IN_FORCE
  limit_price: string
  client_order_id: string
  legs: readonly Readonly<{
    symbol: string
    ratio_qty: string
    side: "buy" | "sell"
    position_intent: "buy_to_open" | "sell_to_open"
  }>[]
}>

/**
 * Builds the exact Alpaca multi-leg request for an approved strategy.
 *
 * The limit price is the net premium per strategy unit the risk gate already
 * bounded. Every leg opens, so a partially recognized request can never leave
 * a naked short: Alpaca accepts or rejects the `mleg` order as one unit.
 *
 * @param intent Approved trade intent.
 * @param clientOrderId Idempotency key; the ledger cycle id.
 * @returns The request body sent to `POST /v2/orders`.
 */
export function buildAlpacaMlegOrderRequestV1(
  intent: TradeIntentV4,
  clientOrderId: string,
): AlpacaMlegOrderRequestV1 {
  return {
    order_class: "mleg",
    qty: String(APPROVED_ORDER_QUANTITY),
    type: "limit",
    time_in_force: ORDER_TIME_IN_FORCE,
    limit_price: centsToDecimalString(intent.entryLimitCentsPerStrategyUnit),
    client_order_id: clientOrderId,
    legs: intent.legs.map((leg) => ({
      symbol: leg.contractSymbol,
      ratio_qty: String(leg.ratioQuantity),
      side: leg.positionIntent === "BUY_TO_OPEN" ? "buy" as const : "sell" as const,
      position_intent:
        leg.positionIntent === "BUY_TO_OPEN"
          ? "buy_to_open" as const
          : "sell_to_open" as const,
    })),
  }
}

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const positiveSafeInteger = z.number().int().positive().safe()

export const orderSubmittedPayloadV1Schema = z
  .object({
    submissionVersion: z.literal(ORDER_SUBMISSION_VERSION),
    clientOrderId: identifier,
    ruleVersion: identifier,
    strategy: z.string().min(1).max(64),
    underlying: z.string().min(1).max(16),
    legs: z
      .array(
        z
          .object({
            contractSymbol: alpacaOptionSymbolSchema,
            positionIntent: z.enum(["BUY_TO_OPEN", "SELL_TO_OPEN"]),
            ratioQuantity: positiveSafeInteger,
          })
          .strict(),
      )
      .min(1)
      .max(4),
    quantity: z.literal(APPROVED_ORDER_QUANTITY),
    limitPriceCentsPerStrategyUnit: positiveSafeInteger,
    maxLossCents: positiveSafeInteger,
    timeInForce: z.literal(ORDER_TIME_IN_FORCE),
    quoteSnapshotRef: z.string().min(1).max(128),
  })
  .strict()

export const orderFilledPayloadV1Schema = z
  .object({
    submissionVersion: z.literal(ORDER_SUBMISSION_VERSION),
    clientOrderId: identifier,
    brokerOrderId: identifier,
    filledQuantity: positiveSafeInteger,
    filledAvgPriceCentsPerShare: positiveSafeInteger.optional(),
    brokerTimestamp: timestamp,
  })
  .strict()

export const orderRejectedPayloadV1Schema = z
  .object({
    submissionVersion: z.literal(ORDER_SUBMISSION_VERSION),
    clientOrderId: identifier,
    brokerOrderId: identifier.optional(),
    reason: z.enum(ORDER_TERMINAL_REJECTION_CODES),
    observedAt: timestamp,
  })
  .strict()

export type OrderSubmittedPayloadV1 = Readonly<
  z.infer<typeof orderSubmittedPayloadV1Schema>
>
export type OrderFilledPayloadV1 = Readonly<
  z.infer<typeof orderFilledPayloadV1Schema>
>
export type OrderRejectedPayloadV1 = Readonly<
  z.infer<typeof orderRejectedPayloadV1Schema>
>

/**
 * Projects the durable submission record for an approved intent.
 *
 * @param intent Approved trade intent.
 * @param clientOrderId Idempotency key; the ledger cycle id.
 * @param ruleVersion Risk rule version that approved the intent.
 * @param maxLossCents Bounded loss the risk gate approved.
 */
export function createOrderSubmittedPayloadV1(
  intent: TradeIntentV4,
  clientOrderId: string,
  ruleVersion: string,
  maxLossCents: number,
): OrderSubmittedPayloadV1 {
  return orderSubmittedPayloadV1Schema.parse({
    submissionVersion: ORDER_SUBMISSION_VERSION,
    clientOrderId,
    ruleVersion,
    strategy: intent.strategy,
    underlying: intent.underlying,
    legs: intent.legs.map(({ contractSymbol, positionIntent, ratioQuantity }) => ({
      contractSymbol,
      positionIntent,
      ratioQuantity,
    })),
    quantity: APPROVED_ORDER_QUANTITY,
    limitPriceCentsPerStrategyUnit: intent.entryLimitCentsPerStrategyUnit,
    maxLossCents,
    timeInForce: ORDER_TIME_IN_FORCE,
    quoteSnapshotRef: intent.quoteSnapshotRef,
  })
}
