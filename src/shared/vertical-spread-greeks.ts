import { z } from "zod"

export const VERTICAL_SPREAD_GREEKS_CALCULATION = "LONG_MINUS_SHORT" as const

const netGreek = z.number().finite()

export const verticalSpreadGreeksV1Schema = z
  .object({
    calculation: z.literal(VERTICAL_SPREAD_GREEKS_CALCULATION),
    netDelta: netGreek,
    netGamma: netGreek,
    netTheta: netGreek,
    netVega: netGreek,
  })
  .strict()

export type VerticalSpreadGreeksV1 = Readonly<
  z.infer<typeof verticalSpreadGreeksV1Schema>
>

type OptionLegGreeks = Readonly<{
  delta: number
  gamma: number
  theta: number
  vega: number
}>

const finiteDifference = (longValue: number, shortValue: number) => {
  const difference = longValue - shortValue
  if (!Number.isFinite(difference)) return undefined
  if (difference === 0) return 0
  return Number(difference.toPrecision(12))
}

/** Calculates one-long/one-short vertical exposure using position signs. */
export function deriveVerticalSpreadGreeksV1(
  longLeg: OptionLegGreeks,
  shortLeg: OptionLegGreeks,
): VerticalSpreadGreeksV1 | undefined {
  const netDelta = finiteDifference(longLeg.delta, shortLeg.delta)
  const netGamma = finiteDifference(longLeg.gamma, shortLeg.gamma)
  const netTheta = finiteDifference(longLeg.theta, shortLeg.theta)
  const netVega = finiteDifference(longLeg.vega, shortLeg.vega)
  if (
    netDelta === undefined ||
    netGamma === undefined ||
    netTheta === undefined ||
    netVega === undefined
  ) return undefined

  return {
    calculation: VERTICAL_SPREAD_GREEKS_CALCULATION,
    netDelta,
    netGamma,
    netTheta,
    netVega,
  }
}
