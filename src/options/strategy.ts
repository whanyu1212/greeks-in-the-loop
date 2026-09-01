import { z } from "zod"

export const OPTION_STRATEGIES = [
  "LONG_CALL",
  "LONG_PUT",
  "COVERED_CALL",
  "CASH_SECURED_PUT",
  "BULL_CALL_SPREAD",
  "BEAR_PUT_SPREAD",
  "BEAR_CALL_SPREAD",
  "BULL_PUT_SPREAD",
  "LONG_STRADDLE",
  "LONG_STRANGLE",
  "CALL_BUTTERFLY",
  "PUT_BUTTERFLY",
  "IRON_BUTTERFLY",
  "IRON_CONDOR",
  "COLLAR",
  "CALENDAR_SPREAD",
  "DIAGONAL_SPREAD",
  "DEFINED_RISK_MLEG",
] as const

export const optionStrategySchema = z.enum(OPTION_STRATEGIES)
export type OptionStrategy = z.infer<typeof optionStrategySchema>

export type OptionStrategyDefinition = Readonly<{
  minimumAlpacaLevel: 1 | 2 | 3
  orderClass: "SIMPLE" | "MLEG"
  legCount: Readonly<{ min: 1 | 2 | 3 | 4; max: 1 | 2 | 3 | 4 }>
  outlook: "BULLISH" | "BEARISH" | "NEUTRAL" | "VOLATILITY"
  premium: "DEBIT" | "CREDIT" | "EITHER"
  collateral: "PREMIUM" | "SHARES" | "CASH" | "DEFINED_RISK"
  expirationRelation: "SINGLE" | "MULTIPLE"
}>

/** Broker-neutral strategy semantics for every Alpaca-supported entry family. */
export const OPTION_STRATEGY_CATALOG = {
  LONG_CALL: definition(2, "SIMPLE", 1, 1, "BULLISH", "DEBIT", "PREMIUM", "SINGLE"),
  LONG_PUT: definition(2, "SIMPLE", 1, 1, "BEARISH", "DEBIT", "PREMIUM", "SINGLE"),
  COVERED_CALL: definition(1, "SIMPLE", 1, 1, "NEUTRAL", "CREDIT", "SHARES", "SINGLE"),
  CASH_SECURED_PUT: definition(1, "SIMPLE", 1, 1, "BULLISH", "CREDIT", "CASH", "SINGLE"),
  BULL_CALL_SPREAD: definition(3, "MLEG", 2, 2, "BULLISH", "DEBIT", "DEFINED_RISK", "SINGLE"),
  BEAR_PUT_SPREAD: definition(3, "MLEG", 2, 2, "BEARISH", "DEBIT", "DEFINED_RISK", "SINGLE"),
  BEAR_CALL_SPREAD: definition(3, "MLEG", 2, 2, "BEARISH", "CREDIT", "DEFINED_RISK", "SINGLE"),
  BULL_PUT_SPREAD: definition(3, "MLEG", 2, 2, "BULLISH", "CREDIT", "DEFINED_RISK", "SINGLE"),
  LONG_STRADDLE: definition(3, "MLEG", 2, 2, "VOLATILITY", "DEBIT", "PREMIUM", "SINGLE"),
  LONG_STRANGLE: definition(3, "MLEG", 2, 2, "VOLATILITY", "DEBIT", "PREMIUM", "SINGLE"),
  CALL_BUTTERFLY: definition(3, "MLEG", 3, 3, "NEUTRAL", "EITHER", "DEFINED_RISK", "SINGLE"),
  PUT_BUTTERFLY: definition(3, "MLEG", 3, 3, "NEUTRAL", "EITHER", "DEFINED_RISK", "SINGLE"),
  IRON_BUTTERFLY: definition(3, "MLEG", 4, 4, "NEUTRAL", "EITHER", "DEFINED_RISK", "SINGLE"),
  IRON_CONDOR: definition(3, "MLEG", 4, 4, "NEUTRAL", "EITHER", "DEFINED_RISK", "SINGLE"),
  COLLAR: definition(3, "MLEG", 2, 2, "NEUTRAL", "EITHER", "SHARES", "SINGLE"),
  CALENDAR_SPREAD: definition(3, "MLEG", 2, 2, "NEUTRAL", "EITHER", "DEFINED_RISK", "MULTIPLE"),
  DIAGONAL_SPREAD: definition(3, "MLEG", 2, 2, "NEUTRAL", "EITHER", "DEFINED_RISK", "MULTIPLE"),
  DEFINED_RISK_MLEG: definition(3, "MLEG", 2, 4, "NEUTRAL", "EITHER", "DEFINED_RISK", "MULTIPLE"),
} as const satisfies Record<OptionStrategy, OptionStrategyDefinition>

function definition(
  minimumAlpacaLevel: 1 | 2 | 3,
  orderClass: "SIMPLE" | "MLEG",
  minLegs: 1 | 2 | 3 | 4,
  maxLegs: 1 | 2 | 3 | 4,
  outlook: OptionStrategyDefinition["outlook"],
  premium: OptionStrategyDefinition["premium"],
  collateral: OptionStrategyDefinition["collateral"],
  expirationRelation: OptionStrategyDefinition["expirationRelation"],
): OptionStrategyDefinition {
  return {
    minimumAlpacaLevel,
    orderClass,
    legCount: { min: minLegs, max: maxLegs },
    outlook,
    premium,
    collateral,
    expirationRelation,
  }
}
