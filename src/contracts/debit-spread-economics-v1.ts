export type DebitSpreadEconomicsV1 = Readonly<{
  entryLimitCentsPerShare: number
  widthCentsPerShare: number
  maxLossCentsPerContract: number
  maxProfitCentsPerContract: number
  stopLossMarkHalfCentsPerShare: number
  profitTargetMarkHalfCentsPerShare: number
}>

export type DebitSpreadEconomicsFailure =
  | "NON_POSITIVE_NET_DEBIT"
  | "ENTRY_LIMIT_NOT_BELOW_WIDTH"
  | "ARITHMETIC_OVERFLOW"

type ExactQuotePrices = Readonly<{
  bidCentsPerShare: number
  askCentsPerShare: number
}>

/** Calculates exact one-contract debit-spread economics using integer cents. */
export function calculateDebitSpreadEconomicsV1(
  longQuote: ExactQuotePrices,
  shortQuote: ExactQuotePrices,
  longStrikeCents: number,
  shortStrikeCents: number,
):
  | { success: true; economics: DebitSpreadEconomicsV1 }
  | { success: false; reason: DebitSpreadEconomicsFailure } {
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
  const derivedValues = [
    widthCents,
    entryLimitCents,
    maxLossCents,
    maxProfitCents,
    profitTargetMarkHalfCents,
  ]
  if (derivedValues.some((value) => value > BigInt(Number.MAX_SAFE_INTEGER))) {
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
