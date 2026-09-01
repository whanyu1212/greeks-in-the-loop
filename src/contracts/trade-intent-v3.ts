import { z } from "zod"

import {
  alpacaOptionStrikeCents,
  alpacaOptionSymbolSchema,
  optionUnderlyingV1Schema,
  parseAlpacaOptionSymbol,
} from "../shared/alpaca-option-identity.js"
import { parseRfc3339Nanoseconds } from "../shared/value-normalization.js"
import {
  RESEARCH_DECISION_CONTRACT_VERSION,
  type TradeProposalV3,
} from "./research-decision-v3.js"

export const TRADE_INTENT_CONTRACT_VERSION = "3.0.0" as const

const MAX_QUOTE_AGE_NANOSECONDS = 60_000_000_000n
const timestamp = z.iso.datetime({ offset: true })
const evaluatedAtTimestamp = z.iso.datetime({ offset: true, precision: 3 })
const expirationDate = z.iso.date().refine((value) => {
  const year = Number(value.slice(0, 4))
  return year >= 2000 && year <= 2099
})
const positiveSafeInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)

type DebitSpreadEconomicsFailure =
  | "NON_POSITIVE_NET_DEBIT"
  | "ENTRY_LIMIT_NOT_BELOW_WIDTH"
  | "ARITHMETIC_OVERFLOW"

const calculateDebitSpreadEconomics = (
  longQuote: Readonly<{
    bidCentsPerShare: number
    askCentsPerShare: number
  }>,
  shortQuote: Readonly<{
    bidCentsPerShare: number
    askCentsPerShare: number
  }>,
  longStrikeCents: number,
  shortStrikeCents: number,
):
  | {
      success: true
      economics: Readonly<{
        entryLimitCentsPerShare: number
        widthCentsPerShare: number
        maxLossCentsPerContract: number
        maxProfitCentsPerContract: number
        stopLossMarkHalfCentsPerShare: number
        profitTargetMarkHalfCentsPerShare: number
      }>
    }
  | { success: false; reason: DebitSpreadEconomicsFailure } => {
  const widthCents = BigInt(Math.abs(longStrikeCents - shortStrikeCents))
  const netMidpointHalfCents =
    BigInt(longQuote.bidCentsPerShare) +
    BigInt(longQuote.askCentsPerShare) -
    BigInt(shortQuote.bidCentsPerShare) -
    BigInt(shortQuote.askCentsPerShare)

  if (netMidpointHalfCents <= 0n) {
    return { success: false, reason: "NON_POSITIVE_NET_DEBIT" }
  }

  const entryLimitCents = (netMidpointHalfCents + 1n) / 2n
  if (entryLimitCents >= widthCents) {
    return { success: false, reason: "ENTRY_LIMIT_NOT_BELOW_WIDTH" }
  }

  const maxLossCents = entryLimitCents * 100n
  const maxProfitCents = (widthCents - entryLimitCents) * 100n
  const profitTargetMarkHalfCents = entryLimitCents + widthCents
  if (
    [
      widthCents,
      entryLimitCents,
      maxLossCents,
      maxProfitCents,
      profitTargetMarkHalfCents,
    ].some((value) => value > BigInt(Number.MAX_SAFE_INTEGER))
  ) {
    return { success: false, reason: "ARITHMETIC_OVERFLOW" }
  }

  const entryLimitCentsPerShare = Number(entryLimitCents)
  return {
    success: true,
    economics: {
      entryLimitCentsPerShare,
      widthCentsPerShare: Number(widthCents),
      maxLossCentsPerContract: Number(maxLossCents),
      maxProfitCentsPerContract: Number(maxProfitCents),
      stopLossMarkHalfCentsPerShare: entryLimitCentsPerShare,
      profitTargetMarkHalfCentsPerShare: Number(profitTargetMarkHalfCents),
    },
  }
}

export const confirmedOptionQuoteV2Schema = z
  .object({
    contractSymbol: alpacaOptionSymbolSchema,
    feed: z.literal("INDICATIVE"),
    bidCentsPerShare: positiveSafeInteger,
    askCentsPerShare: positiveSafeInteger,
    providerTimestamp: timestamp,
  })
  .strict()
  .superRefine((quote, refinement) => {
    if (quote.askCentsPerShare <= quote.bidCentsPerShare) {
      refinement.addIssue({
        code: "custom",
        path: ["askCentsPerShare"],
        message: "The option ask must be greater than its bid",
      })
    }
  })

export type ConfirmedOptionQuoteV2 = Readonly<
  z.infer<typeof confirmedOptionQuoteV2Schema>
>

export const tradeIntentV3Schema = z
  .object({
    contractVersion: z.literal(TRADE_INTENT_CONTRACT_VERSION),
    decisionContractVersion: z.literal(RESEARCH_DECISION_CONTRACT_VERSION),
    underlying: optionUnderlyingV1Schema,
    direction: z.enum(["BULLISH", "BEARISH"]),
    structure: z.enum(["BULL_CALL_SPREAD", "BEAR_PUT_SPREAD"]),
    expiration: expirationDate,
    longContractSymbol: alpacaOptionSymbolSchema,
    shortContractSymbol: alpacaOptionSymbolSchema,
    quoteSnapshotRef: z.string().min(1).max(128),
    evaluatedAt: evaluatedAtTimestamp,
    longQuote: confirmedOptionQuoteV2Schema,
    shortQuote: confirmedOptionQuoteV2Schema,
    entryLimitCentsPerShare: positiveSafeInteger,
    widthCentsPerShare: positiveSafeInteger,
    maxLossCentsPerContract: positiveSafeInteger,
    maxProfitCentsPerContract: positiveSafeInteger,
    stopLossMarkHalfCentsPerShare: positiveSafeInteger,
    profitTargetMarkHalfCentsPerShare: positiveSafeInteger,
  })
  .strict()
  .superRefine((intent, refinement) => {
    const expectedStructure =
      intent.direction === "BULLISH" ? "BULL_CALL_SPREAD" : "BEAR_PUT_SPREAD"
    if (intent.structure !== expectedStructure) {
      refinement.addIssue({
        code: "custom",
        path: ["structure"],
        message: "The intent structure does not match its direction",
      })
    }

    if (
      intent.longQuote.contractSymbol !== intent.longContractSymbol ||
      intent.shortQuote.contractSymbol !== intent.shortContractSymbol
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["longQuote", "contractSymbol"],
        message: "The confirmed quotes do not match the intent legs",
      })
    }

    const longSymbol = parseAlpacaOptionSymbol(intent.longContractSymbol)
    const shortSymbol = parseAlpacaOptionSymbol(intent.shortContractSymbol)
    const expectedOptionType = intent.structure === "BULL_CALL_SPREAD" ? "C" : "P"
    if (
      !longSymbol.success ||
      !shortSymbol.success ||
      longSymbol.identity.root !== intent.underlying ||
      longSymbol.identity.root !== shortSymbol.identity.root ||
      longSymbol.identity.expiration !== intent.expiration ||
      shortSymbol.identity.expiration !== intent.expiration ||
      longSymbol.identity.optionType !== expectedOptionType ||
      shortSymbol.identity.optionType !== expectedOptionType
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["longContractSymbol"],
        message: "The option symbols do not match the intent identity",
      })
      return
    }

    const longStrike = alpacaOptionStrikeCents(longSymbol.identity)
    const shortStrike = alpacaOptionStrikeCents(shortSymbol.identity)
    if (!longStrike.success || !shortStrike.success) {
      refinement.addIssue({
        code: "custom",
        path: ["longContractSymbol"],
        message: "The option symbols do not match the intent identity",
      })
      return
    }

    const strikesAreOrdered =
      intent.structure === "BULL_CALL_SPREAD"
        ? longStrike.strikeCentsPerShare < shortStrike.strikeCentsPerShare
        : longStrike.strikeCentsPerShare > shortStrike.strikeCentsPerShare
    if (!strikesAreOrdered) {
      refinement.addIssue({
        code: "custom",
        path: ["shortContractSymbol"],
        message: "The option strikes are not ordered for the intent structure",
      })
    }

    const evaluatedAt = parseRfc3339Nanoseconds(intent.evaluatedAt)
    for (const [quoteName, quote] of [
      ["longQuote", intent.longQuote],
      ["shortQuote", intent.shortQuote],
    ] as const) {
      const providerTimestamp = parseRfc3339Nanoseconds(
        quote.providerTimestamp,
      )
      if (
        evaluatedAt === undefined ||
        providerTimestamp === undefined ||
        providerTimestamp > evaluatedAt ||
        evaluatedAt - providerTimestamp > MAX_QUOTE_AGE_NANOSECONDS
      ) {
        refinement.addIssue({
          code: "custom",
          path: [quoteName, "providerTimestamp"],
          message: "The confirmed quote is not fresh at intent evaluation",
        })
      }
    }

    const calculation = calculateDebitSpreadEconomics(
      intent.longQuote,
      intent.shortQuote,
      longStrike.strikeCentsPerShare,
      shortStrike.strikeCentsPerShare,
    )
    if (!calculation.success) {
      refinement.addIssue({
        code: "custom",
        path: ["entryLimitCentsPerShare"],
        message: "The intent economics cannot be derived from its inputs",
      })
      return
    }

    for (const field of [
      "entryLimitCentsPerShare",
      "widthCentsPerShare",
      "maxLossCentsPerContract",
      "maxProfitCentsPerContract",
      "stopLossMarkHalfCentsPerShare",
      "profitTargetMarkHalfCentsPerShare",
    ] as const) {
      if (intent[field] !== calculation.economics[field]) {
        refinement.addIssue({
          code: "custom",
          path: [field],
          message: "The derived intent field does not match its exact inputs",
        })
      }
    }
  })

export type TradeIntentV3 = Readonly<z.infer<typeof tradeIntentV3Schema>>

export type TradeIntentDerivationContextV3 = Readonly<{
  quoteSnapshotRef: string
  evaluatedAt: string
  longQuote: ConfirmedOptionQuoteV2
  shortQuote: ConfirmedOptionQuoteV2
}>

export type TradeIntentDerivationReason =
  | "DERIVATION_INPUT_INVALID"
  | "QUOTE_SYMBOL_MISMATCH"
  | "STRIKE_PRECISION_UNSUPPORTED"
  | "NON_POSITIVE_NET_DEBIT"
  | "ENTRY_LIMIT_NOT_BELOW_WIDTH"
  | "ARITHMETIC_OVERFLOW"

export type TradeIntentDerivationResultV3 =
  | {
      success: true
      intent: TradeIntentV3
    }
  | {
      success: false
      reasons: readonly TradeIntentDerivationReason[]
    }

const derivationContextSchema = z
  .object({
    quoteSnapshotRef: z.string().min(1).max(128),
    evaluatedAt: evaluatedAtTimestamp,
    longQuote: confirmedOptionQuoteV2Schema,
    shortQuote: confirmedOptionQuoteV2Schema,
  })
  .strict()

/**
 * Derives a non-executable pre-risk trade intent from a validated proposal.
 *
 * All financial calculations use safe integers. Quote prices and strikes are
 * cents per share, while contract profit and loss are cents for one 100-share
 * option contract. Exit marks use half-cents per share so the strategy's 50%
 * thresholds remain exact.
 *
 * @param decision Validated agent-authored trade proposal.
 * @param context Application-owned exact-leg quote context.
 * @returns A deterministic intent or bounded derivation reasons.
 */
export function deriveTradeIntentV3(
  decision: TradeProposalV3,
  context: TradeIntentDerivationContextV3,
): TradeIntentDerivationResultV3 {
  const parsedContext = derivationContextSchema.safeParse(context)
  if (!parsedContext.success) {
    return { success: false, reasons: ["DERIVATION_INPUT_INVALID"] }
  }

  if (
    parsedContext.data.longQuote.contractSymbol !==
      decision.candidate.longLeg.contractSymbol ||
    parsedContext.data.shortQuote.contractSymbol !==
      decision.candidate.shortLeg.contractSymbol
  ) {
    return { success: false, reasons: ["QUOTE_SYMBOL_MISMATCH"] }
  }

  const longSymbol = parseAlpacaOptionSymbol(
    decision.candidate.longLeg.contractSymbol,
  )
  const shortSymbol = parseAlpacaOptionSymbol(
    decision.candidate.shortLeg.contractSymbol,
  )
  if (
    !longSymbol.success ||
    !shortSymbol.success
  ) {
    return { success: false, reasons: ["DERIVATION_INPUT_INVALID"] }
  }

  const longStrike = alpacaOptionStrikeCents(longSymbol.identity)
  const shortStrike = alpacaOptionStrikeCents(shortSymbol.identity)
  if (!longStrike.success || !shortStrike.success) {
    return { success: false, reasons: ["STRIKE_PRECISION_UNSUPPORTED"] }
  }

  const calculation = calculateDebitSpreadEconomics(
    parsedContext.data.longQuote,
    parsedContext.data.shortQuote,
    longStrike.strikeCentsPerShare,
    shortStrike.strikeCentsPerShare,
  )
  if (!calculation.success) {
    return { success: false, reasons: [calculation.reason] }
  }

  const parsedIntent = tradeIntentV3Schema.safeParse({
    contractVersion: TRADE_INTENT_CONTRACT_VERSION,
    decisionContractVersion: RESEARCH_DECISION_CONTRACT_VERSION,
    underlying: decision.candidate.underlying,
    direction: decision.direction,
    structure: decision.candidate.structure,
    expiration: decision.candidate.expiration,
    longContractSymbol: decision.candidate.longLeg.contractSymbol,
    shortContractSymbol: decision.candidate.shortLeg.contractSymbol,
    quoteSnapshotRef: parsedContext.data.quoteSnapshotRef,
    evaluatedAt: parsedContext.data.evaluatedAt,
    longQuote: parsedContext.data.longQuote,
    shortQuote: parsedContext.data.shortQuote,
    ...calculation.economics,
  })
  if (!parsedIntent.success) {
    return { success: false, reasons: ["DERIVATION_INPUT_INVALID"] }
  }

  return { success: true, intent: parsedIntent.data }
}
