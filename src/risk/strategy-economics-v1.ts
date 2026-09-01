import { z } from "zod"

import type { TradeIntentV4 } from "../contracts/trade-intent-v4.js"
import {
  optionStrategySchema,
  OPTION_STRATEGY_CATALOG,
} from "../options/strategy.js"
import {
  alpacaOptionStrikeCents,
  parseAlpacaOptionSymbol,
} from "../shared/alpaca-option-identity.js"

const safeCents = z.number().int().nonnegative().safe()

export const strategyEconomicsV1Schema = z
  .object({
    strategy: optionStrategySchema,
    premiumEffect: z.enum(["DEBIT", "CREDIT"]),
    entryPremiumCents: safeCents.positive(),
    maxLossCents: safeCents,
    maxProfitCents: safeCents.nullable(),
    buyingPowerRequirementCents: safeCents,
    collateral: z.enum(["PREMIUM", "SHARES", "CASH", "DEFINED_RISK"]),
  })
  .strict()

export type StrategyEconomicsV1 = Readonly<
  z.infer<typeof strategyEconomicsV1Schema>
>

export type StrategyEconomicsResultV1 =
  | Readonly<{ success: true; economics: StrategyEconomicsV1 }>
  | Readonly<{
      success: false
      reason: "ECONOMICS_INPUT_INVALID" | "MAX_LOSS_UNBOUNDED"
    }>

type ParsedLeg = Readonly<{
  strikeCents: number
  optionType: "C" | "P"
  expiration: string
  sign: 1 | -1
  quantity: number
}>

const safeNumber = (value: bigint) =>
  value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : undefined

const optionPayoff = (leg: ParsedLeg, underlyingCents: bigint) => {
  const strike = BigInt(leg.strikeCents)
  const intrinsic = leg.optionType === "C"
    ? underlyingCents > strike ? underlyingCents - strike : 0n
    : strike > underlyingCents ? strike - underlyingCents : 0n
  return intrinsic * BigInt(leg.sign * leg.quantity * 100)
}

/** Derives bounded per-unit economics without broker state or ambient prices. */
export function deriveStrategyEconomicsV1(
  intent: TradeIntentV4,
): StrategyEconomicsResultV1 {
  const definition = OPTION_STRATEGY_CATALOG[intent.strategy]
  if (
    definition.premium !== "EITHER" &&
    definition.premium !== intent.premiumEffect
  ) return { success: false, reason: "ECONOMICS_INPUT_INVALID" }

  const entryPremium = BigInt(intent.entryLimitCentsPerStrategyUnit) * 100n
  const entryPremiumCents = safeNumber(entryPremium)
  if (entryPremiumCents === undefined) {
    return { success: false, reason: "ECONOMICS_INPUT_INVALID" }
  }
  const parsedLegs: ParsedLeg[] = []
  for (const leg of intent.legs) {
    const identity = parseAlpacaOptionSymbol(leg.contractSymbol)
    if (!identity.success) {
      return { success: false, reason: "ECONOMICS_INPUT_INVALID" }
    }
    const strike = alpacaOptionStrikeCents(identity.identity)
    if (!strike.success) {
      return { success: false, reason: "ECONOMICS_INPUT_INVALID" }
    }
    parsedLegs.push({
      strikeCents: strike.strikeCentsPerShare,
      optionType: identity.identity.optionType,
      expiration: identity.identity.expiration,
      sign: leg.positionIntent === "BUY_TO_OPEN" ? 1 : -1,
      quantity: leg.ratioQuantity,
    })
  }

  const base = {
    strategy: intent.strategy,
    premiumEffect: intent.premiumEffect,
    entryPremiumCents,
    collateral: definition.collateral,
  } as const
  if (intent.strategy === "COVERED_CALL") {
    return {
      success: true,
      economics: strategyEconomicsV1Schema.parse({
        ...base,
        maxLossCents: 0,
        maxProfitCents: safeNumber(entryPremium),
        buyingPowerRequirementCents: 0,
      }),
    }
  }
  if (intent.strategy === "CASH_SECURED_PUT") {
    const strikeCash = BigInt(parsedLegs[0]!.strikeCents) * 100n
    const maxLoss = strikeCash - entryPremium
    const maxLossCents = safeNumber(maxLoss)
    if (maxLossCents === undefined) {
      return { success: false, reason: "ECONOMICS_INPUT_INVALID" }
    }
    return {
      success: true,
      economics: strategyEconomicsV1Schema.parse({
        ...base,
        maxLossCents,
        maxProfitCents: safeNumber(entryPremium),
        buyingPowerRequirementCents: safeNumber(strikeCash),
      }),
    }
  }
  if (intent.strategy === "COLLAR") {
    const maxLoss = intent.premiumEffect === "DEBIT" ? entryPremium : 0n
    return {
      success: true,
      economics: strategyEconomicsV1Schema.parse({
        ...base,
        maxLossCents: safeNumber(maxLoss),
        maxProfitCents: null,
        buyingPowerRequirementCents: safeNumber(maxLoss),
      }),
    }
  }

  const expirations = new Set(parsedLegs.map(({ expiration }) => expiration))
  if (expirations.size > 1) {
    if (
      intent.strategy !== "CALENDAR_SPREAD" &&
      intent.strategy !== "DIAGONAL_SPREAD"
    ) {
      return { success: false, reason: "ECONOMICS_INPUT_INVALID" }
    }
    const purchased = parsedLegs.find(({ sign }) => sign === 1)
    const sold = parsedLegs.find(({ sign }) => sign === -1)
    if (purchased === undefined || sold === undefined) {
      return { success: false, reason: "ECONOMICS_INPUT_INVALID" }
    }
    const adverseStrikeWidth = purchased.optionType === "C"
      ? Math.max(0, purchased.strikeCents - sold.strikeCents)
      : Math.max(0, sold.strikeCents - purchased.strikeCents)
    const assignmentRisk = BigInt(adverseStrikeWidth) * 100n
    const maxLoss = intent.premiumEffect === "DEBIT"
      ? entryPremium + assignmentRisk
      : assignmentRisk > entryPremium ? assignmentRisk - entryPremium : 0n
    const maxLossCents = safeNumber(maxLoss)
    if (maxLossCents === undefined) {
      return { success: false, reason: "ECONOMICS_INPUT_INVALID" }
    }
    return {
      success: true,
      economics: strategyEconomicsV1Schema.parse({
        ...base,
        maxLossCents,
        maxProfitCents: null,
        buyingPowerRequirementCents: maxLossCents,
      }),
    }
  }

  const openingCashflow = intent.premiumEffect === "CREDIT"
    ? entryPremium
    : -entryPremium
  const prices = [0, ...new Set(parsedLegs.map(({ strikeCents }) => strikeCents))]
  const profits = prices.map((price) => parsedLegs.reduce(
    (total, leg) => total + optionPayoff(leg, BigInt(price)),
    openingCashflow,
  ))
  const callSlope = parsedLegs
    .filter(({ optionType }) => optionType === "C")
    .reduce((total, leg) => total + leg.sign * leg.quantity, 0)
  if (callSlope < 0) return { success: false, reason: "MAX_LOSS_UNBOUNDED" }

  const minimumProfit = profits.reduce((minimum, value) =>
    value < minimum ? value : minimum
  )
  const maximumProfit = profits.reduce((maximum, value) =>
    value > maximum ? value : maximum
  )
  const maxLoss = minimumProfit < 0n ? -minimumProfit : 0n
  const maxLossCents = safeNumber(maxLoss)
  const maxProfitCents = callSlope > 0
    ? null
    : safeNumber(maximumProfit > 0n ? maximumProfit : 0n)
  if (maxLossCents === undefined || maxProfitCents === undefined) {
    return { success: false, reason: "ECONOMICS_INPUT_INVALID" }
  }
  return {
    success: true,
    economics: strategyEconomicsV1Schema.parse({
      ...base,
      maxLossCents,
      maxProfitCents,
      buyingPowerRequirementCents: maxLossCents,
    }),
  }
}
