import { z } from "zod"

const ALPACA_COMPACT_OPTION_SYMBOL_PATTERN =
  /^([A-Z0-9]{1,6})(\d{6})([CP])(\d{8})$/u

export const ALPACA_OPTION_SYMBOL_PARSE_FAILURE_CODES = [
  "SYMBOL_FORMAT_INVALID",
  "EXPIRATION_DATE_INVALID",
] as const
export type AlpacaOptionSymbolParseFailureCode =
  (typeof ALPACA_OPTION_SYMBOL_PARSE_FAILURE_CODES)[number]

export const OPTION_UNIVERSE_POLICY_VERSION = "1.0.0" as const
export const ALLOWED_OPTION_UNDERLYINGS_V1 = ["SPY", "QQQ", "IWM"] as const
export type AllowedOptionUnderlyingV1 =
  (typeof ALLOWED_OPTION_UNDERLYINGS_V1)[number]
export const OPTION_UNIVERSE_V1_FAILURE_CODES = [
  "UNDERLYING_NOT_SUPPORTED",
] as const
export type OptionUniverseV1FailureCode =
  (typeof OPTION_UNIVERSE_V1_FAILURE_CODES)[number]

export type AlpacaOptionIdentity = Readonly<{
  provider: "ALPACA"
  brokerSymbol: string
  root: string
  expiration: string
  optionType: "C" | "P"
  strikeThousandthsPerShare: number
}>

export type ParseAlpacaOptionSymbolResult =
  | Readonly<{
      success: true
      identity: AlpacaOptionIdentity
    }>
  | Readonly<{
      success: false
      reason: AlpacaOptionSymbolParseFailureCode
    }>

export type OptionUniverseV1Result =
  | Readonly<{ success: true }>
  | Readonly<{
      success: false
      reason: OptionUniverseV1FailureCode
    }>

export type AlpacaOptionStrikeCentsResult =
  | Readonly<{
      success: true
      strikeCentsPerShare: number
    }>
  | Readonly<{
      success: false
      reason: "STRIKE_PRECISION_UNSUPPORTED"
    }>

/**
 * Parses the exact compact option-symbol dialect returned by Alpaca.
 *
 * The broker symbol is retained byte-for-byte. Syntax parsing deliberately does
 * not authorize an underlying or require cent-denominated strike precision.
 *
 * @param brokerSymbol Compact Alpaca option symbol.
 * @returns Parsed provider identity or a bounded failure reason.
 */
export function parseAlpacaOptionSymbol(
  brokerSymbol: string,
): ParseAlpacaOptionSymbolResult {
  const match = ALPACA_COMPACT_OPTION_SYMBOL_PATTERN.exec(brokerSymbol)
  if (match === null) {
    return { success: false, reason: "SYMBOL_FORMAT_INVALID" }
  }

  const [, root, encodedExpiration, optionType, encodedStrike] = match
  if (
    root === undefined ||
    encodedExpiration === undefined ||
    (optionType !== "C" && optionType !== "P") ||
    encodedStrike === undefined
  ) {
    return { success: false, reason: "SYMBOL_FORMAT_INVALID" }
  }

  const year = 2000 + Number(encodedExpiration.slice(0, 2))
  const month = Number(encodedExpiration.slice(2, 4))
  const day = Number(encodedExpiration.slice(4, 6))
  const calendarDate = new Date(Date.UTC(year, month - 1, day))
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    return { success: false, reason: "EXPIRATION_DATE_INVALID" }
  }

  const strikeThousandthsPerShare = Number(encodedStrike)
  if (!Number.isSafeInteger(strikeThousandthsPerShare)) {
    return { success: false, reason: "SYMBOL_FORMAT_INVALID" }
  }

  return {
    success: true,
    identity: {
      provider: "ALPACA",
      brokerSymbol,
      root,
      expiration: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      optionType,
      strikeThousandthsPerShare,
    },
  }
}

/**
 * Applies the current strategy-universe policy independently of symbol syntax.
 */
export function validateOptionUniverseV1(
  identity: AlpacaOptionIdentity,
): OptionUniverseV1Result {
  return ALLOWED_OPTION_UNDERLYINGS_V1.includes(
    identity.root as AllowedOptionUnderlyingV1,
  )
    ? { success: true }
    : { success: false, reason: "UNDERLYING_NOT_SUPPORTED" }
}

/**
 * Projects an exact Alpaca strike into the cent unit used by financial paths.
 */
export function alpacaOptionStrikeCents(
  identity: AlpacaOptionIdentity,
): AlpacaOptionStrikeCentsResult {
  if (identity.strikeThousandthsPerShare % 10 !== 0) {
    return { success: false, reason: "STRIKE_PRECISION_UNSUPPORTED" }
  }
  return {
    success: true,
    strikeCentsPerShare: identity.strikeThousandthsPerShare / 10,
  }
}

/** Syntax and calendar validity only. Universe authorization is separate. */
export const alpacaOptionSymbolSchema = z
  .string()
  .regex(ALPACA_COMPACT_OPTION_SYMBOL_PATTERN)
  .superRefine((symbol, refinement) => {
    const parsed = parseAlpacaOptionSymbol(symbol)
    if (!parsed.success && parsed.reason === "EXPIRATION_DATE_INVALID") {
      refinement.addIssue({
        code: "custom",
        message: "The Alpaca option expiration date is invalid",
      })
    }
  })

/** Compact Alpaca syntax composed with the current bounded universe policy. */
export const allowedAlpacaOptionSymbolV1Schema = alpacaOptionSymbolSchema.superRefine(
  (symbol, refinement) => {
    const parsed = parseAlpacaOptionSymbol(symbol)
    if (
      parsed.success &&
      !validateOptionUniverseV1(parsed.identity).success
    ) {
      refinement.addIssue({
        code: "custom",
        message: "The option underlying is not supported by the V1 universe",
      })
    }
  },
)
