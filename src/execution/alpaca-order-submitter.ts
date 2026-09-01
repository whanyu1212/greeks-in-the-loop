import { z } from "zod"

import type { TradeIntentV4 } from "../contracts/trade-intent-v4.js"
import {
  buildAlpacaMlegOrderRequestV1,
  type OrderTerminalRejectionCode,
} from "./order-submission-v1.js"

/**
 * The only module in this codebase permitted to mutate broker state.
 *
 * It is reached exclusively from `executeApprovedTradeV1`, after a durable
 * `ORDER_SUBMITTED` record exists. The research agent has no path here: the
 * OpenCode permission boundary denies `alpaca_*` and this client is never
 * exposed as a tool.
 */

/**
 * Paper trading only.
 *
 * Architecture plan sections 6.A and 9 require the paper endpoint and an
 * assertion of it both at startup and immediately before submission. The live
 * origin is deliberately absent so no configuration can reach it.
 */
const PAPER_TRADING_ORIGIN = "https://paper-api.alpaca.markets" as const
const ALLOWED_TRADING_ORIGINS = [PAPER_TRADING_ORIGIN] as const

const normalizeBaseUrl = (value: string, allowCustomHost: boolean) => {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      (!allowCustomHost &&
        !ALLOWED_TRADING_ORIGINS.includes(
          url.origin as (typeof ALLOWED_TRADING_ORIGINS)[number],
        ))
    ) throw new Error("invalid origin")
    return url.origin
  } catch {
    throw new Error(
      "ALPACA_TRADING_BASE_URL must be the credential-free Alpaca paper HTTPS URL",
    )
  }
}

const decimal = z.union([z.string(), z.number()])
const rawOrderSchema = z
  .object({
    id: z.string().min(1),
    client_order_id: z.string().min(1),
    status: z.string().min(1),
    filled_qty: decimal.nullish(),
    filled_avg_price: decimal.nullish(),
    filled_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    submitted_at: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough()

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u

const exactCents = (value: unknown) => {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined
    const cents = Math.round(value * 100)
    return Math.abs(cents / 100 - value) < 1e-9 ? cents : undefined
  }
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!DECIMAL_PATTERN.test(trimmed)) return undefined
  const [whole, fraction = ""] = trimmed.replace(/^[+]/u, "").split(".")
  const padded = `${fraction}00`.slice(0, 2)
  const magnitude = Number(`${whole!.replace("-", "")}${padded}`)
  if (!Number.isSafeInteger(magnitude)) return undefined
  return trimmed.startsWith("-") ? -magnitude : magnitude
}

const wholeQuantity = (value: unknown) => {
  if (value === null || value === undefined) return undefined
  const parsed = typeof value === "number" ? value : Number(String(value).trim())
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/** Alpaca order states that can still become a fill. */
const OPEN_ORDER_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "accepted_for_bidding",
  "partially_filled",
  "held",
  "calculated",
  "pending_replace",
  "replaced",
])

const REJECTION_BY_STATUS: Readonly<Record<string, OrderTerminalRejectionCode>> = {
  rejected: "BROKER_REJECTED",
  canceled: "ORDER_CANCELED",
  pending_cancel: "ORDER_CANCELED",
  expired: "ORDER_EXPIRED",
  done_for_day: "ORDER_EXPIRED",
  stopped: "BROKER_REJECTED",
  suspended: "BROKER_REJECTED",
}

export type BrokerOrderOutcome =
  | Readonly<{
      status: "FILLED"
      brokerOrderId: string
      filledQuantity: number
      filledAvgPriceCentsPerShare?: number
      brokerTimestamp: string
    }>
  | Readonly<{
      status: "OPEN"
      brokerOrderId: string
      brokerStatus: string
    }>
  | Readonly<{
      status: "REJECTED"
      brokerOrderId?: string
      reason: OrderTerminalRejectionCode
    }>

export type OrderSubmitter = Readonly<{
  /** Submits one approved intent. Safe to retry: the client order id dedupes. */
  submit(
    input: Readonly<{
      intent: TradeIntentV4
      clientOrderId: string
      signal: AbortSignal
    }>,
  ): Promise<BrokerOrderOutcome>
  /** Resolves what the broker holds for one client order id, if anything. */
  lookup(
    input: Readonly<{ clientOrderId: string; signal: AbortSignal }>,
  ): Promise<BrokerOrderOutcome | undefined>
}>

export type CreateAlpacaOrderSubmitterOptions = Readonly<{
  apiKey: string
  secretKey: string
  tradingBaseUrl?: string
  fetch?: typeof fetch
  now?: () => Date
}>

/**
 * Normalizes one raw Alpaca order into a bounded outcome.
 *
 * Unknown statuses are treated as open rather than filled or rejected, so an
 * unrecognized state resolves on the next reconciliation instead of inventing
 * a terminal record.
 */
const normalizeOrder = (raw: unknown): BrokerOrderOutcome | undefined => {
  const parsed = rawOrderSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const order = parsed.data
  const status = order.status.trim().toLowerCase()

  if (status === "filled") {
    const filledQuantity = wholeQuantity(order.filled_qty)
    const brokerTimestamp =
      order.filled_at ?? order.updated_at ?? order.submitted_at ?? order.created_at
    const parsedTimestamp = brokerTimestamp
      ? Date.parse(brokerTimestamp)
      : Number.NaN
    if (
      filledQuantity === undefined ||
      filledQuantity <= 0 ||
      !Number.isFinite(parsedTimestamp)
    ) return undefined
    const averagePrice = exactCents(order.filled_avg_price)
    return {
      status: "FILLED",
      brokerOrderId: order.id,
      filledQuantity,
      ...(averagePrice === undefined || averagePrice <= 0
        ? {}
        : { filledAvgPriceCentsPerShare: averagePrice }),
      brokerTimestamp: new Date(parsedTimestamp).toISOString(),
    }
  }

  const rejection = REJECTION_BY_STATUS[status]
  if (rejection !== undefined) {
    return { status: "REJECTED", brokerOrderId: order.id, reason: rejection }
  }

  return {
    status: "OPEN",
    brokerOrderId: order.id,
    brokerStatus: OPEN_ORDER_STATUSES.has(status) ? status : "unknown",
  }
}

/** Creates the Alpaca order submitter used by the deterministic executor. */
export function createAlpacaOrderSubmitter(
  options: CreateAlpacaOrderSubmitterOptions,
): OrderSubmitter {
  const request = options.fetch ?? fetch
  const tradingBaseUrl = normalizeBaseUrl(
    options.tradingBaseUrl ?? ALLOWED_TRADING_ORIGINS[0],
    options.fetch !== undefined,
  )
  const headers = {
    "APCA-API-KEY-ID": options.apiKey,
    "APCA-API-SECRET-KEY": options.secretKey,
    "Content-Type": "application/json",
  }

  const lookup: OrderSubmitter["lookup"] = async ({ clientOrderId, signal }) => {
    const url = new URL("/v2/orders:by_client_order_id", tradingBaseUrl)
    url.searchParams.set("client_order_id", clientOrderId)
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
      return undefined
    }
    if (response.status === 404) return undefined
    if (!response.ok) return undefined
    try {
      return normalizeOrder(await response.json())
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      return undefined
    }
  }

  return {
    async submit({ intent, clientOrderId, signal }) {
      signal.throwIfAborted()
      // Plan section 9: assert the paper endpoint immediately before submission.
      if (tradingBaseUrl !== PAPER_TRADING_ORIGIN) {
        throw new Error("Order submission is restricted to the Alpaca paper endpoint")
      }
      const body = buildAlpacaMlegOrderRequestV1(intent, clientOrderId)
      let response: Response
      try {
        response = await request(new URL("/v2/orders", tradingBaseUrl), {
          method: "POST",
          redirect: "error",
          headers,
          body: JSON.stringify(body),
          signal,
        })
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        // The request may still have reached the broker. Resolve by identity
        // rather than assuming nothing was created.
        const existing = await lookup({ clientOrderId, signal })
        return existing ?? { status: "REJECTED", reason: "BROKER_REQUEST_FAILED" }
      }

      if (!response.ok) {
        // A duplicate client order id is a successful dedupe, not a failure.
        const existing = await lookup({ clientOrderId, signal })
        if (existing !== undefined) return existing
        return {
          status: "REJECTED",
          reason:
            response.status >= 500
              ? "BROKER_REQUEST_FAILED"
              : "BROKER_REJECTED",
        }
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        const existing = await lookup({ clientOrderId, signal })
        return existing ?? { status: "REJECTED", reason: "BROKER_RESPONSE_INVALID" }
      }

      const normalized = normalizeOrder(payload)
      if (normalized === undefined) {
        const existing = await lookup({ clientOrderId, signal })
        return existing ?? { status: "REJECTED", reason: "BROKER_RESPONSE_INVALID" }
      }
      return normalized
    },
    lookup,
  }
}
