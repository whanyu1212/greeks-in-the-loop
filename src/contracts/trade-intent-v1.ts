import { z } from "zod"

import { parseRfc3339Nanoseconds } from "../shared/value-normalization.js"
import { calculateDebitSpreadEconomicsV1 } from "./debit-spread-economics-v1.js"
import {
  RESEARCH_DECISION_CONTRACT_VERSION,
  STRATEGY_VERSION,
  type ProposedTradeDecisionV1,
} from "./research-decision-v1.js"

export const TRADE_INTENT_CONTRACT_VERSION = "1.0.0" as const

const SPY_OPTION_SYMBOL_PATTERN = /^SPY(\d{6})([CP])(\d{8})$/u
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

type ParsedOptionSymbol = Readonly<{
  expiration: string
  optionType: "C" | "P"
  strikeCentsPerShare: number
}>

/**
 * Parses identity and an exact cent-denominated strike from an OCC symbol.
 *
 * @param symbol SPY OCC option symbol.
 * @returns Parsed identity, or `undefined` when the strike has sub-cent
 *     precision or the symbol is malformed.
 */
const parseOptionSymbol = (symbol: string): ParsedOptionSymbol | undefined => {
  const match = SPY_OPTION_SYMBOL_PATTERN.exec(symbol)
  const expiration = match?.[1]
  const optionType = match?.[2]
  const encodedStrike = match?.[3]
  if (
    expiration === undefined ||
    (optionType !== "C" && optionType !== "P") ||
    encodedStrike === undefined
  ) {
    return undefined
  }

  const strikeThousandths = Number(encodedStrike)
  if (
    !Number.isSafeInteger(strikeThousandths) ||
    strikeThousandths % 10 !== 0
  ) {
    return undefined
  }

  return {
    expiration: `20${expiration.slice(0, 2)}-${expiration.slice(2, 4)}-${expiration.slice(4, 6)}`,
    optionType,
    strikeCentsPerShare: strikeThousandths / 10,
  }
}

export const confirmedOptionQuoteV1Schema = z
  .object({
    contractSymbol: z.string().regex(SPY_OPTION_SYMBOL_PATTERN),
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

export type ConfirmedOptionQuoteV1 = Readonly<
  z.infer<typeof confirmedOptionQuoteV1Schema>
>

export const tradeIntentV1Schema = z
  .object({
    contractVersion: z.literal(TRADE_INTENT_CONTRACT_VERSION),
    decisionContractVersion: z.literal(RESEARCH_DECISION_CONTRACT_VERSION),
    strategyVersion: z.literal(STRATEGY_VERSION),
    direction: z.enum(["BULLISH", "BEARISH"]),
    structure: z.enum(["BULL_CALL_SPREAD", "BEAR_PUT_SPREAD"]),
    expiration: expirationDate,
    longContractSymbol: z.string().regex(SPY_OPTION_SYMBOL_PATTERN),
    shortContractSymbol: z.string().regex(SPY_OPTION_SYMBOL_PATTERN),
    quoteSnapshotRef: z.string().min(1).max(128),
    evaluatedAt: evaluatedAtTimestamp,
    longQuote: confirmedOptionQuoteV1Schema,
    shortQuote: confirmedOptionQuoteV1Schema,
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

    const longSymbol = parseOptionSymbol(intent.longContractSymbol)
    const shortSymbol = parseOptionSymbol(intent.shortContractSymbol)
    const expectedOptionType = intent.structure === "BULL_CALL_SPREAD" ? "C" : "P"
    if (
      longSymbol === undefined ||
      shortSymbol === undefined ||
      longSymbol.expiration !== intent.expiration ||
      shortSymbol.expiration !== intent.expiration ||
      longSymbol.optionType !== expectedOptionType ||
      shortSymbol.optionType !== expectedOptionType
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["longContractSymbol"],
        message: "The option symbols do not match the intent identity",
      })
      return
    }

    const strikesAreOrdered =
      intent.structure === "BULL_CALL_SPREAD"
        ? longSymbol.strikeCentsPerShare < shortSymbol.strikeCentsPerShare
        : longSymbol.strikeCentsPerShare > shortSymbol.strikeCentsPerShare
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

    const calculation = calculateDebitSpreadEconomicsV1(
      intent.longQuote,
      intent.shortQuote,
      longSymbol.strikeCentsPerShare,
      shortSymbol.strikeCentsPerShare,
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

export type TradeIntentV1 = Readonly<z.infer<typeof tradeIntentV1Schema>>

export type TradeIntentDerivationContext = Readonly<{
  quoteSnapshotRef: string
  evaluatedAt: string
  longQuote: ConfirmedOptionQuoteV1
  shortQuote: ConfirmedOptionQuoteV1
}>

export type TradeIntentDerivationReason =
  | "DERIVATION_INPUT_INVALID"
  | "QUOTE_SYMBOL_MISMATCH"
  | "STRIKE_PRECISION_UNSUPPORTED"
  | "NON_POSITIVE_NET_DEBIT"
  | "ENTRY_LIMIT_NOT_BELOW_WIDTH"
  | "ARITHMETIC_OVERFLOW"

export type TradeIntentDerivationResult =
  | {
      success: true
      intent: TradeIntentV1
    }
  | {
      success: false
      reasons: readonly TradeIntentDerivationReason[]
    }

const derivationContextSchema = z
  .object({
    quoteSnapshotRef: z.string().min(1).max(128),
    evaluatedAt: evaluatedAtTimestamp,
    longQuote: confirmedOptionQuoteV1Schema,
    shortQuote: confirmedOptionQuoteV1Schema,
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
export function deriveTradeIntentV1(
  decision: ProposedTradeDecisionV1,
  context: TradeIntentDerivationContext,
): TradeIntentDerivationResult {
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

  const longSymbol = parseOptionSymbol(
    decision.candidate.longLeg.contractSymbol,
  )
  const shortSymbol = parseOptionSymbol(
    decision.candidate.shortLeg.contractSymbol,
  )
  if (longSymbol === undefined || shortSymbol === undefined) {
    return { success: false, reasons: ["STRIKE_PRECISION_UNSUPPORTED"] }
  }

  const calculation = calculateDebitSpreadEconomicsV1(
    parsedContext.data.longQuote,
    parsedContext.data.shortQuote,
    longSymbol.strikeCentsPerShare,
    shortSymbol.strikeCentsPerShare,
  )
  if (!calculation.success) {
    return { success: false, reasons: [calculation.reason] }
  }

  const parsedIntent = tradeIntentV1Schema.safeParse({
    contractVersion: TRADE_INTENT_CONTRACT_VERSION,
    decisionContractVersion: RESEARCH_DECISION_CONTRACT_VERSION,
    strategyVersion: STRATEGY_VERSION,
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
