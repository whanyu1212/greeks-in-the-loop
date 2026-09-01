import { z } from "zod"

import {
  ALPACA_OPTION_ORDER_CAPABILITY_VERSION,
  alpacaOptionEntryPlanV2Schema,
} from "../options/alpaca-capabilities.js"
import { optionStrategySchema } from "../options/strategy.js"
import { optionUnderlyingV1Schema } from "../shared/alpaca-option-identity.js"
import { parseRfc3339Nanoseconds } from "../shared/value-normalization.js"
import {
  RESEARCH_DECISION_V4_CONTRACT_VERSION,
  type TradeProposalV4,
} from "./research-decision-v4.js"
import {
  confirmedOptionQuoteV2Schema,
  type ConfirmedOptionQuoteV2,
} from "./trade-intent-v3.js"

export const TRADE_INTENT_V4_CONTRACT_VERSION = "4.0.0" as const
const MAX_QUOTE_AGE_NANOSECONDS = 60_000_000_000n
const positiveSafeInteger = z.number().int().positive().safe()
const evaluatedAtTimestamp = z.iso.datetime({ offset: true, precision: 3 })

const quotedEntryLegV4Schema = z
  .object({
    contractSymbol: confirmedOptionQuoteV2Schema.shape.contractSymbol,
    positionIntent: z.enum(["BUY_TO_OPEN", "SELL_TO_OPEN"]),
    ratioQuantity: positiveSafeInteger,
    quote: confirmedOptionQuoteV2Schema,
  })
  .strict()
  .superRefine((leg, refinement) => {
    if (leg.quote.contractSymbol !== leg.contractSymbol) {
      refinement.addIssue({
        code: "custom",
        path: ["quote", "contractSymbol"],
        message: "The confirmed quote must match its intent leg",
      })
    }
  })

const premiumFrom = (legs: readonly Readonly<{
  positionIntent: "BUY_TO_OPEN" | "SELL_TO_OPEN"
  ratioQuantity: number
  quote: Readonly<{ bidCentsPerShare: number; askCentsPerShare: number }>
}>[]) => {
  const signed = legs.reduce((total, leg) => total +
    BigInt(leg.ratioQuantity) * BigInt(
      leg.positionIntent === "BUY_TO_OPEN"
        ? leg.quote.askCentsPerShare
        : -leg.quote.bidCentsPerShare,
    ), 0n)
  if (signed === 0n || signed > BigInt(Number.MAX_SAFE_INTEGER) ||
    signed < -BigInt(Number.MAX_SAFE_INTEGER)) return undefined
  return {
    premiumEffect: signed > 0n ? "DEBIT" as const : "CREDIT" as const,
    entryLimitCentsPerStrategyUnit: Number(signed < 0n ? -signed : signed),
  }
}

export const tradeIntentV4Schema = z
  .object({
    contractVersion: z.literal(TRADE_INTENT_V4_CONTRACT_VERSION),
    decisionContractVersion: z.literal(RESEARCH_DECISION_V4_CONTRACT_VERSION),
    underlying: optionUnderlyingV1Schema,
    direction: z.enum(["BULLISH", "BEARISH", "NEUTRAL", "VOLATILITY"]),
    strategy: optionStrategySchema,
    quoteSnapshotRef: z.string().min(1).max(128),
    evaluatedAt: evaluatedAtTimestamp,
    legs: z.array(quotedEntryLegV4Schema).min(1).max(4),
    premiumEffect: z.enum(["DEBIT", "CREDIT"]),
    entryLimitCentsPerStrategyUnit: positiveSafeInteger,
  })
  .strict()
  .superRefine((intent, refinement) => {
    const plan = alpacaOptionEntryPlanV2Schema.safeParse({
      capabilityVersion: ALPACA_OPTION_ORDER_CAPABILITY_VERSION,
      strategy: intent.strategy,
      underlying: intent.underlying,
      legs: intent.legs.map(
        ({ contractSymbol, positionIntent, ratioQuantity }) => ({
          contractSymbol,
          positionIntent,
          ratioQuantity,
        }),
      ),
    })
    if (!plan.success) {
      refinement.addIssue({
        code: "custom",
        path: ["legs"],
        message: "Intent legs do not match the declared Alpaca strategy",
      })
    }
    const evaluatedAt = parseRfc3339Nanoseconds(intent.evaluatedAt)
    intent.legs.forEach((leg, index) => {
      const providerTimestamp = parseRfc3339Nanoseconds(
        leg.quote.providerTimestamp,
      )
      if (
        evaluatedAt === undefined ||
        providerTimestamp === undefined ||
        providerTimestamp > evaluatedAt ||
        evaluatedAt - providerTimestamp > MAX_QUOTE_AGE_NANOSECONDS
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["legs", index, "quote", "providerTimestamp"],
          message: "The confirmed quote is not fresh at intent evaluation",
        })
      }
    })
    const premium = premiumFrom(intent.legs)
    if (
      premium === undefined ||
      premium.premiumEffect !== intent.premiumEffect ||
      premium.entryLimitCentsPerStrategyUnit !==
        intent.entryLimitCentsPerStrategyUnit
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["entryLimitCentsPerStrategyUnit"],
        message: "Intent premium must match the exact ordered-leg quotes",
      })
    }
  })

export type TradeIntentV4 = Readonly<z.infer<typeof tradeIntentV4Schema>>
export type TradeIntentDerivationContextV4 = Readonly<{
  quoteSnapshotRef: string
  evaluatedAt: string
  quotes: readonly ConfirmedOptionQuoteV2[]
}>
export type TradeIntentDerivationReasonV4 =
  | "DERIVATION_INPUT_INVALID"
  | "QUOTE_SYMBOL_MISMATCH"
  | "ZERO_NET_PREMIUM"
  | "ARITHMETIC_OVERFLOW"
export type TradeIntentDerivationResultV4 =
  | Readonly<{ success: true; intent: TradeIntentV4 }>
  | Readonly<{
      success: false
      reasons: readonly TradeIntentDerivationReasonV4[]
    }>

const contextSchema = z
  .object({
    quoteSnapshotRef: z.string().min(1).max(128),
    evaluatedAt: evaluatedAtTimestamp,
    quotes: z.array(confirmedOptionQuoteV2Schema).min(1).max(4),
  })
  .strict()

/** Derives a generic, non-executable premium intent from exact ordered legs. */
export function deriveTradeIntentV4(
  proposal: TradeProposalV4,
  context: TradeIntentDerivationContextV4,
): TradeIntentDerivationResultV4 {
  const parsedContext = contextSchema.safeParse(context)
  if (!parsedContext.success) {
    return { success: false, reasons: ["DERIVATION_INPUT_INVALID"] }
  }
  const quoteBySymbol = new Map(
    parsedContext.data.quotes.map((quote) => [quote.contractSymbol, quote]),
  )
  const legs = proposal.candidate.legs.map((leg) => ({
    ...leg,
    quote: quoteBySymbol.get(leg.contractSymbol),
  }))
  if (legs.some(({ quote }) => quote === undefined) ||
    quoteBySymbol.size !== proposal.candidate.legs.length) {
    return { success: false, reasons: ["QUOTE_SYMBOL_MISMATCH"] }
  }
  const quotedLegs = legs as Array<{
    contractSymbol: string
    positionIntent: "BUY_TO_OPEN" | "SELL_TO_OPEN"
    ratioQuantity: number
    quote: ConfirmedOptionQuoteV2
  }>
  const premium = premiumFrom(quotedLegs)
  if (premium === undefined) {
    const signed = quotedLegs.reduce((total, leg) => total +
      BigInt(leg.ratioQuantity) * BigInt(
        leg.positionIntent === "BUY_TO_OPEN"
          ? leg.quote.askCentsPerShare
          : -leg.quote.bidCentsPerShare,
      ), 0n)
    return {
      success: false,
      reasons: [signed === 0n ? "ZERO_NET_PREMIUM" : "ARITHMETIC_OVERFLOW"],
    }
  }
  const parsed = tradeIntentV4Schema.safeParse({
    contractVersion: TRADE_INTENT_V4_CONTRACT_VERSION,
    decisionContractVersion: RESEARCH_DECISION_V4_CONTRACT_VERSION,
    underlying: proposal.candidate.underlying,
    direction: proposal.direction,
    strategy: proposal.candidate.strategy,
    quoteSnapshotRef: parsedContext.data.quoteSnapshotRef,
    evaluatedAt: parsedContext.data.evaluatedAt,
    legs: quotedLegs,
    ...premium,
  })
  return parsed.success
    ? { success: true, intent: parsed.data }
    : { success: false, reasons: ["DERIVATION_INPUT_INVALID"] }
}
