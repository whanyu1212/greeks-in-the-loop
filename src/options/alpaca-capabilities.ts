import { z } from "zod"

import {
  optionStrategySchema,
  OPTION_STRATEGY_CATALOG,
  type OptionStrategy,
} from "./strategy.js"
import {
  alpacaOptionSymbolSchema,
  optionUnderlyingV1Schema,
  parseAlpacaOptionSymbol,
} from "../shared/alpaca-option-identity.js"

export const ALPACA_MAX_OPTION_ORDER_LEGS = 4
export const ALPACA_OPTION_ORDER_CAPABILITY_VERSION = "1.0.0" as const

export const ALPACA_OPTION_POSITION_INTENTS = [
  "BUY_TO_OPEN",
  "SELL_TO_OPEN",
  "BUY_TO_CLOSE",
  "SELL_TO_CLOSE",
] as const

const positionIntentSchema = z.enum(ALPACA_OPTION_POSITION_INTENTS)

export const alpacaOptionOrderLegV1Schema = z
  .object({
    contractSymbol: alpacaOptionSymbolSchema,
    ratioQuantity: z.number().int().positive().safe(),
    positionIntent: positionIntentSchema,
  })
  .strict()

export const alpacaOptionOrderPlanV1Schema = z
  .object({
    capabilityVersion: z.literal(ALPACA_OPTION_ORDER_CAPABILITY_VERSION),
    strategy: optionStrategySchema,
    underlying: optionUnderlyingV1Schema,
    legs: z.array(alpacaOptionOrderLegV1Schema).min(1).max(
      ALPACA_MAX_OPTION_ORDER_LEGS,
    ),
  })
  .strict()
  .superRefine((plan, refinement) => {
    const definition = OPTION_STRATEGY_CATALOG[plan.strategy]
    if (
      plan.legs.length < definition.legCount.min ||
      plan.legs.length > definition.legCount.max
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["legs"],
        message: "The leg count does not match the strategy",
      })
    }

    if (
      definition.orderClass === "SIMPLE" && plan.legs.length !== 1 ||
      definition.orderClass === "MLEG" && plan.legs.length < 2
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["legs"],
        message: "The legs do not match the required Alpaca order class",
      })
    }

    if (greatestCommonDivisor(plan.legs.map(({ ratioQuantity }) => ratioQuantity)) !== 1) {
      refinement.addIssue({
        code: "custom",
        path: ["legs"],
        message: "Alpaca multi-leg ratios must be in simplest form",
      })
    }

    const symbols = new Set<string>()
    plan.legs.forEach((leg, index) => {
      if (symbols.has(leg.contractSymbol)) {
        refinement.addIssue({
          code: "custom",
          path: ["legs", index, "contractSymbol"],
          message: "An opening plan cannot repeat a contract",
        })
      }
      symbols.add(leg.contractSymbol)

      const identity = parseAlpacaOptionSymbol(leg.contractSymbol)
      if (!identity.success || identity.identity.root !== plan.underlying) {
        refinement.addIssue({
          code: "custom",
          path: ["legs", index, "contractSymbol"],
          message: "Every option leg must use the plan underlying",
        })
      }
    })
  })

export type AlpacaOptionOrderLegV1 = Readonly<
  z.infer<typeof alpacaOptionOrderLegV1Schema>
>
export type AlpacaOptionOrderPlanV1 = Readonly<
  Omit<z.infer<typeof alpacaOptionOrderPlanV1Schema>, "legs"> & {
    legs: readonly AlpacaOptionOrderLegV1[]
  }
>

export type AlpacaOpeningCoverageResult =
  | Readonly<{ covered: true }>
  | Readonly<{
      covered: false
      reason: "CLOSING_LEG_PRESENT" | "UNCOVERED_SHORT_LEG"
    }>

/**
 * Proves structural opening coverage without consulting account collateral.
 * Level-one share and cash collateral are deliberately left to fresh risk state.
 */
export function evaluateAlpacaOpeningCoverageV1(
  plan: AlpacaOptionOrderPlanV1,
): AlpacaOpeningCoverageResult {
  if (plan.legs.some(({ positionIntent }) => positionIntent.endsWith("_TO_CLOSE"))) {
    return { covered: false, reason: "CLOSING_LEG_PRESENT" }
  }

  const definition = OPTION_STRATEGY_CATALOG[plan.strategy]
  if (definition.collateral === "SHARES" || definition.collateral === "CASH") {
    return { covered: true }
  }

  const quantities = new Map<string, { bought: number; sold: number }>()
  for (const leg of plan.legs) {
    const identity = parseAlpacaOptionSymbol(leg.contractSymbol)
    if (!identity.success) return { covered: false, reason: "UNCOVERED_SHORT_LEG" }
    const key = [
      identity.identity.expiration,
      identity.identity.optionType,
    ].join(":")
    const quantity = quantities.get(key) ?? { bought: 0, sold: 0 }
    if (leg.positionIntent === "BUY_TO_OPEN") {
      quantity.bought += leg.ratioQuantity
    } else {
      quantity.sold += leg.ratioQuantity
    }
    quantities.set(key, quantity)
  }

  return [...quantities.values()].every(({ bought, sold }) => sold <= bought)
    ? { covered: true }
    : { covered: false, reason: "UNCOVERED_SHORT_LEG" }
}

export const alpacaMinimumLevelFor = (strategy: OptionStrategy) =>
  OPTION_STRATEGY_CATALOG[strategy].minimumAlpacaLevel

const greatestCommonDivisor = (values: readonly number[]) => {
  const pair = (left: number, right: number): number =>
    right === 0 ? left : pair(right, left % right)
  return values.reduce(pair)
}
