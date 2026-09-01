export const OPTION_LEG_AGGREGATE_GREEKS_CALCULATION =
  "POSITION_WEIGHTED_SUM" as const

type OptionLegGreeks = Readonly<{
  positionIntent: "BUY_TO_OPEN" | "SELL_TO_OPEN"
  ratioQuantity: number
  delta: number
  gamma: number
  theta: number
  vega: number
}>

const aggregate = (
  legs: readonly OptionLegGreeks[],
  metric: "delta" | "gamma" | "theta" | "vega",
) => {
  const value = legs.reduce(
    (total, leg) => total +
      (leg.positionIntent === "BUY_TO_OPEN" ? 1 : -1) *
        leg.ratioQuantity * leg[metric],
    0,
  )
  if (!Number.isFinite(value)) return undefined
  return value === 0 ? 0 : Number(value.toPrecision(12))
}

/** Aggregates opening-leg Greeks using Alpaca ratio quantities and position signs. */
export function deriveOptionLegAggregateGreeksV1(
  legs: readonly OptionLegGreeks[],
) {
  if (legs.length < 1 || legs.length > 4) return undefined
  const netDelta = aggregate(legs, "delta")
  const netGamma = aggregate(legs, "gamma")
  const netTheta = aggregate(legs, "theta")
  const netVega = aggregate(legs, "vega")
  if (
    netDelta === undefined ||
    netGamma === undefined ||
    netTheta === undefined ||
    netVega === undefined
  ) return undefined
  return {
    calculation: OPTION_LEG_AGGREGATE_GREEKS_CALCULATION,
    netDelta,
    netGamma,
    netTheta,
    netVega,
  }
}
