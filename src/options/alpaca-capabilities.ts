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
export const ALPACA_OPTION_ORDER_CAPABILITY_VERSION = "2.0.0" as const

export const ALPACA_OPTION_POSITION_INTENTS = [
  "BUY_TO_OPEN",
  "SELL_TO_OPEN",
  "BUY_TO_CLOSE",
  "SELL_TO_CLOSE",
] as const

const entryPositionIntentSchema = z.enum(["BUY_TO_OPEN", "SELL_TO_OPEN"])

export const alpacaOptionEntryLegV2Schema = z
  .object({
    contractSymbol: alpacaOptionSymbolSchema,
    ratioQuantity: z.number().int().positive().safe(),
    positionIntent: entryPositionIntentSchema,
  })
  .strict()

export const alpacaOptionEntryPlanV2Schema = z
  .object({
    capabilityVersion: z.literal(ALPACA_OPTION_ORDER_CAPABILITY_VERSION),
    strategy: optionStrategySchema,
    underlying: optionUnderlyingV1Schema,
    legs: z.array(alpacaOptionEntryLegV2Schema).min(1).max(
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
    const parsedLegs = plan.legs.map((leg, index) => {
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
        return undefined
      }
      return { ...leg, identity: identity.identity }
    })
    if (
      parsedLegs.every((leg) => leg !== undefined) &&
      !strategyShapeIsValid(plan.strategy, parsedLegs)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["legs"],
        message: "The option legs do not match the declared strategy",
      })
    }
  })

export type AlpacaOptionEntryLegV2 = Readonly<
  z.infer<typeof alpacaOptionEntryLegV2Schema>
>
export type AlpacaOptionEntryPlanV2 = Readonly<
  Omit<z.infer<typeof alpacaOptionEntryPlanV2Schema>, "legs"> & {
    legs: readonly AlpacaOptionEntryLegV2[]
  }
>

export type AlpacaOpeningCoverageResult =
  | Readonly<{ covered: true }>
  | Readonly<{
      covered: false
      reason: "UNCOVERED_SHORT_LEG"
    }>

/**
 * Proves structural opening coverage without consulting account collateral.
 * Level-one share and cash collateral are deliberately left to fresh risk state.
 */
export function evaluateAlpacaOpeningCoverageV1(
  plan: AlpacaOptionEntryPlanV2,
): AlpacaOpeningCoverageResult {
  const definition = OPTION_STRATEGY_CATALOG[plan.strategy]
  if (definition.collateral === "SHARES" || definition.collateral === "CASH") {
    return { covered: true }
  }

  const legs = [] as Array<Readonly<{
    expiration: string
    optionType: "C" | "P"
    bought: boolean
    quantity: number
  }>>
  for (const leg of plan.legs) {
    const identity = parseAlpacaOptionSymbol(leg.contractSymbol)
    if (!identity.success) return { covered: false, reason: "UNCOVERED_SHORT_LEG" }
    legs.push({
      expiration: identity.identity.expiration,
      optionType: identity.identity.optionType,
      bought: leg.positionIntent === "BUY_TO_OPEN",
      quantity: leg.ratioQuantity,
    })
  }

  for (const optionType of ["C", "P"] as const) {
    const buys = legs
      .filter((leg) => leg.optionType === optionType && leg.bought)
      .map((leg) => ({ ...leg }))
      .sort((left, right) => right.expiration.localeCompare(left.expiration))
    const sells = legs
      .filter((leg) => leg.optionType === optionType && !leg.bought)
      .sort((left, right) => right.expiration.localeCompare(left.expiration))
    for (const sell of sells) {
      let remaining = sell.quantity
      for (const buy of buys) {
        if (buy.expiration < sell.expiration || buy.quantity === 0) continue
        const covered = Math.min(remaining, buy.quantity)
        buy.quantity -= covered
        remaining -= covered
      }
      if (remaining > 0) return { covered: false, reason: "UNCOVERED_SHORT_LEG" }
    }
  }
  return { covered: true }
}

export const alpacaMinimumLevelFor = (strategy: OptionStrategy) =>
  OPTION_STRATEGY_CATALOG[strategy].minimumAlpacaLevel

const greatestCommonDivisor = (values: readonly number[]) => {
  const pair = (left: number, right: number): number =>
    right === 0 ? left : pair(right, left % right)
  return values.reduce(pair)
}

type ParsedEntryLeg = Readonly<
  AlpacaOptionEntryLegV2 & {
    identity: Extract<
      ReturnType<typeof parseAlpacaOptionSymbol>,
      { success: true }
    >["identity"]
  }
>

const bought = (leg: ParsedEntryLeg) => leg.positionIntent === "BUY_TO_OPEN"
const sameExpiration = (legs: readonly ParsedEntryLeg[]) =>
  new Set(legs.map(({ identity }) => identity.expiration)).size === 1
const sameRatio = (legs: readonly ParsedEntryLeg[]) =>
  new Set(legs.map(({ ratioQuantity }) => ratioQuantity)).size === 1
const strike = (leg: ParsedEntryLeg) =>
  leg.identity.strikeThousandthsPerShare

const singleLegShape = (
  legs: readonly ParsedEntryLeg[],
  optionType: "C" | "P",
  isBought: boolean,
) =>
  legs.length === 1 &&
  legs[0]!.identity.optionType === optionType &&
  bought(legs[0]!) === isBought

const verticalShape = (
  legs: readonly ParsedEntryLeg[],
  optionType: "C" | "P",
  buyLowerStrike: boolean,
) => {
  if (
    legs.length !== 2 ||
    !sameExpiration(legs) ||
    !sameRatio(legs) ||
    legs.some(({ identity }) => identity.optionType !== optionType)
  ) return false
  const [lower, higher] = [...legs].sort((left, right) => strike(left) - strike(right))
  return (
    strike(lower!) < strike(higher!) &&
    bought(lower!) === buyLowerStrike &&
    bought(higher!) !== buyLowerStrike
  )
}

const longVolatilityShape = (
  legs: readonly ParsedEntryLeg[],
  equalStrikes: boolean,
) => {
  if (
    legs.length !== 2 ||
    !sameExpiration(legs) ||
    !sameRatio(legs) ||
    legs.some((leg) => !bought(leg)) ||
    new Set(legs.map(({ identity }) => identity.optionType)).size !== 2
  ) return false
  return (strike(legs[0]!) === strike(legs[1]!)) === equalStrikes
}

const butterflyShape = (
  legs: readonly ParsedEntryLeg[],
  optionType: "C" | "P",
) => {
  if (
    legs.length !== 3 ||
    !sameExpiration(legs) ||
    legs.some(({ identity }) => identity.optionType !== optionType)
  ) return false
  const [lower, middle, higher] = [...legs].sort(
    (left, right) => strike(left) - strike(right),
  )
  return (
    strike(middle!) - strike(lower!) === strike(higher!) - strike(middle!) &&
    lower!.ratioQuantity === 1 &&
    middle!.ratioQuantity === 2 &&
    higher!.ratioQuantity === 1 &&
    bought(lower!) === bought(higher!) &&
    bought(middle!) !== bought(lower!)
  )
}

const ironShape = (
  legs: readonly ParsedEntryLeg[],
  innerStrikesEqual: boolean,
) => {
  if (
    legs.length !== 4 ||
    !sameExpiration(legs) ||
    legs.some(({ ratioQuantity }) => ratioQuantity !== 1)
  ) return false
  const puts = legs
    .filter(({ identity }) => identity.optionType === "P")
    .sort((left, right) => strike(left) - strike(right))
  const calls = legs
    .filter(({ identity }) => identity.optionType === "C")
    .sort((left, right) => strike(left) - strike(right))
  if (puts.length !== 2 || calls.length !== 2) return false
  const [outerPut, innerPut] = puts
  const [innerCall, outerCall] = calls
  const standard =
    bought(outerPut!) &&
    !bought(innerPut!) &&
    !bought(innerCall!) &&
    bought(outerCall!)
  const reversed =
    !bought(outerPut!) &&
    bought(innerPut!) &&
    bought(innerCall!) &&
    !bought(outerCall!)
  return (
    (standard || reversed) &&
    (strike(innerPut!) === strike(innerCall!)) === innerStrikesEqual &&
    (innerStrikesEqual || strike(innerPut!) < strike(innerCall!))
  )
}

const collarShape = (legs: readonly ParsedEntryLeg[]) => {
  if (legs.length !== 2 || !sameExpiration(legs) || !sameRatio(legs)) return false
  const put = legs.find(({ identity }) => identity.optionType === "P")
  const call = legs.find(({ identity }) => identity.optionType === "C")
  return (
    put !== undefined &&
    call !== undefined &&
    bought(put) &&
    !bought(call) &&
    strike(put) < strike(call)
  )
}

const timeSpreadShape = (
  legs: readonly ParsedEntryLeg[],
  equalStrikes: boolean,
) => {
  if (
    legs.length !== 2 ||
    !sameRatio(legs) ||
    legs[0]!.identity.optionType !== legs[1]!.identity.optionType ||
    legs[0]!.identity.expiration === legs[1]!.identity.expiration ||
    (strike(legs[0]!) === strike(legs[1]!)) !== equalStrikes
  ) return false
  const purchased = legs.find(bought)
  const sold = legs.find((leg) => !bought(leg))
  return (
    purchased !== undefined &&
    sold !== undefined &&
    purchased.identity.expiration > sold.identity.expiration
  )
}

const hasConservativeCoverage = (legs: readonly ParsedEntryLeg[]) => {
  const quantities = new Map<string, { bought: number; sold: number }>()
  for (const leg of legs) {
    const key = `${leg.identity.expiration}:${leg.identity.optionType}`
    const quantity = quantities.get(key) ?? { bought: 0, sold: 0 }
    if (bought(leg)) quantity.bought += leg.ratioQuantity
    else quantity.sold += leg.ratioQuantity
    quantities.set(key, quantity)
  }
  return [...quantities.values()].every(({ bought: buys, sold }) => sold <= buys)
}

const strategyShapeIsValid = (
  strategy: OptionStrategy,
  legs: readonly ParsedEntryLeg[],
) => {
  switch (strategy) {
    case "LONG_CALL": return singleLegShape(legs, "C", true)
    case "LONG_PUT": return singleLegShape(legs, "P", true)
    case "COVERED_CALL": return singleLegShape(legs, "C", false)
    case "CASH_SECURED_PUT": return singleLegShape(legs, "P", false)
    case "BULL_CALL_SPREAD": return verticalShape(legs, "C", true)
    case "BEAR_CALL_SPREAD": return verticalShape(legs, "C", false)
    case "BEAR_PUT_SPREAD": return verticalShape(legs, "P", false)
    case "BULL_PUT_SPREAD": return verticalShape(legs, "P", true)
    case "LONG_STRADDLE": return longVolatilityShape(legs, true)
    case "LONG_STRANGLE": return longVolatilityShape(legs, false)
    case "CALL_BUTTERFLY": return butterflyShape(legs, "C")
    case "PUT_BUTTERFLY": return butterflyShape(legs, "P")
    case "IRON_BUTTERFLY": return ironShape(legs, true)
    case "IRON_CONDOR": return ironShape(legs, false)
    case "COLLAR": return collarShape(legs)
    case "CALENDAR_SPREAD": return timeSpreadShape(legs, true)
    case "DIAGONAL_SPREAD": return timeSpreadShape(legs, false)
    case "DEFINED_RISK_MLEG": return hasConservativeCoverage(legs)
  }
}
