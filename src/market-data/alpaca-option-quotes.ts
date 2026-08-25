import { z } from "zod"

import type {
  ConfirmedOptionQuoteV1,
} from "../contracts/trade-intent-v1.js"
import type {
  EvidenceSnapshotMetadata,
} from "../contracts/research-decision-v1.js"
import {
  floorNanosecondsToIsoMilliseconds,
  parseExactCents,
  parseRfc3339Nanoseconds,
} from "../shared/value-normalization.js"

const QUOTE_FRESHNESS_NANOSECONDS = 60_000_000_000n
const SPY_OPTION_SYMBOL_PATTERN = /^SPY\d{6}[CP]\d{8}$/u

const latestQuoteSchema = z
  .object({
    bp: z.union([z.number(), z.string()]),
    ap: z.union([z.number(), z.string()]),
    t: z.string(),
  })
  .passthrough()

const optionSnapshotSchema = z
  .object({
    latestQuote: latestQuoteSchema,
  })
  .passthrough()

const snapshotsResponseSchema = z
  .object({
    snapshots: z.record(z.string(), optionSnapshotSchema),
  })
  .passthrough()

export type OptionQuoteConfirmationFailureCode =
  | "QUOTE_REQUEST_FAILED"
  | "QUOTE_RESPONSE_INVALID"
  | "QUOTE_SYMBOL_MISSING"
  | "QUOTE_PRICE_INVALID"
  | "QUOTE_TIMESTAMP_INVALID"
  | "QUOTE_FROM_FUTURE"
  | "QUOTE_STALE"
  | "EVALUATION_TIME_INVALID"

export type ConfirmedOptionQuoteSnapshotV1 = Readonly<{
  evaluatedAt: string
  snapshotMetadata: EvidenceSnapshotMetadata
  longQuote: ConfirmedOptionQuoteV1
  shortQuote: ConfirmedOptionQuoteV1
}>

export type OptionQuoteConfirmationResult =
  | {
      success: true
      snapshot: ConfirmedOptionQuoteSnapshotV1
    }
  | {
      success: false
      reasons: readonly OptionQuoteConfirmationFailureCode[]
    }

export type ConfirmOptionQuotesInput = Readonly<{
  longContractSymbol: string
  shortContractSymbol: string
  signal: AbortSignal
}>

export type OptionQuoteProvider = Readonly<{
  confirmQuotes(
    input: ConfirmOptionQuotesInput,
  ): Promise<OptionQuoteConfirmationResult>
}>

export type AlpacaOptionQuoteProviderOptions = Readonly<{
  apiKey: string
  secretKey: string
  baseUrl?: string
  fetch?: typeof fetch
  now?: () => Date
}>

const failure = (
  reason: OptionQuoteConfirmationFailureCode,
): OptionQuoteConfirmationResult => ({
  success: false,
  reasons: [reason],
})

/**
 * Validates the configurable market-data origin without retaining credentials,
 * paths, queries, or fragments.
 *
 * @param value Configured Alpaca market-data base URL.
 * @returns Canonical HTTPS origin.
 * @throws A bounded error when the value is not a credential-free HTTPS URL.
 */
const normalizeBaseUrl = (
  value: string,
  allowCustomHost: boolean,
): string => {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      (!allowCustomHost && url.hostname !== "data.alpaca.markets")
    ) {
      throw new Error("invalid origin")
    }
    return url.origin
  } catch {
    throw new Error(
      "ALPACA_MARKET_DATA_BASE_URL must be a credential-free Alpaca HTTPS URL",
    )
  }
}

/**
 * Converts one Alpaca quote into exact, bounded application data.
 *
 * @param contractSymbol Exact OCC symbol requested by the application.
 * @param quote Provider quote payload.
 * @param evaluatedAtNanoseconds Application evaluation instant.
 * @returns A confirmed quote and its freshness deadline, or a bounded reason.
 */
const parseQuote = (
  contractSymbol: string,
  quote: z.infer<typeof latestQuoteSchema>,
  evaluatedAtNanoseconds: bigint,
):
  | {
      success: true
      quote: ConfirmedOptionQuoteV1
      freshUntilNanoseconds: bigint
    }
  | {
      success: false
      reason: OptionQuoteConfirmationFailureCode
    } => {
  const bidCentsPerShare = parseExactCents(quote.bp)
  const askCentsPerShare = parseExactCents(quote.ap)
  if (
    bidCentsPerShare === undefined ||
    askCentsPerShare === undefined ||
    bidCentsPerShare <= 0 ||
    askCentsPerShare <= bidCentsPerShare
  ) {
    return { success: false, reason: "QUOTE_PRICE_INVALID" }
  }

  const providerTimestampNanoseconds = parseRfc3339Nanoseconds(quote.t)
  if (providerTimestampNanoseconds === undefined) {
    return { success: false, reason: "QUOTE_TIMESTAMP_INVALID" }
  }
  if (providerTimestampNanoseconds > evaluatedAtNanoseconds) {
    return { success: false, reason: "QUOTE_FROM_FUTURE" }
  }

  const freshUntilNanoseconds =
    providerTimestampNanoseconds + QUOTE_FRESHNESS_NANOSECONDS
  if (freshUntilNanoseconds < evaluatedAtNanoseconds) {
    return { success: false, reason: "QUOTE_STALE" }
  }

  return {
    success: true,
    quote: {
      contractSymbol,
      feed: "INDICATIVE",
      bidCentsPerShare,
      askCentsPerShare,
      providerTimestamp: quote.t,
    },
    freshUntilNanoseconds,
  }
}

/**
 * Creates a read-only Alpaca indicative option-quote provider.
 *
 * The adapter performs one GET request for both exact proposed symbols. It has
 * no broker-trading methods and never includes provider response bodies or
 * credentials in returned failures.
 *
 * @param options Alpaca credentials and injectable transport dependencies.
 * @returns Read-only exact-leg quote confirmation port.
 */
export function createAlpacaOptionQuoteProvider(
  options: AlpacaOptionQuoteProviderOptions,
): OptionQuoteProvider {
  const request = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ?? "https://data.alpaca.markets",
    options.fetch !== undefined,
  )

  return {
    async confirmQuotes({
      longContractSymbol,
      shortContractSymbol,
      signal,
    }): Promise<OptionQuoteConfirmationResult> {
      if (
        !SPY_OPTION_SYMBOL_PATTERN.test(longContractSymbol) ||
        !SPY_OPTION_SYMBOL_PATTERN.test(shortContractSymbol)
      ) {
        return failure("QUOTE_SYMBOL_MISSING")
      }

      const url = new URL("/v1beta1/options/snapshots", baseUrl)
      url.searchParams.set(
        "symbols",
        `${longContractSymbol},${shortContractSymbol}`,
      )
      url.searchParams.set("feed", "indicative")

      let response: Response
      try {
        response = await request(url, {
          method: "GET",
          redirect: "error",
          headers: {
            "APCA-API-KEY-ID": options.apiKey,
            "APCA-API-SECRET-KEY": options.secretKey,
          },
          signal,
        })
      } catch (error) {
        // Deadline and shutdown cancellation must escape the adapter so the
        // interrupted cycle cannot record a misleading quote failure afterward.
        if (signal.aborted) throw signal.reason ?? error
        return failure("QUOTE_REQUEST_FAILED")
      }

      if (!response.ok) return failure("QUOTE_REQUEST_FAILED")

      let rawResponse: unknown
      try {
        rawResponse = await response.json()
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        return failure("QUOTE_RESPONSE_INVALID")
      }

      const parsedResponse = snapshotsResponseSchema.safeParse(rawResponse)
      if (!parsedResponse.success) return failure("QUOTE_RESPONSE_INVALID")

      if (
        !Object.hasOwn(parsedResponse.data.snapshots, longContractSymbol) ||
        !Object.hasOwn(parsedResponse.data.snapshots, shortContractSymbol)
      ) {
        return failure("QUOTE_SYMBOL_MISSING")
      }

      const longSnapshot =
        parsedResponse.data.snapshots[longContractSymbol]
      const shortSnapshot =
        parsedResponse.data.snapshots[shortContractSymbol]
      if (longSnapshot === undefined || shortSnapshot === undefined) {
        return failure("QUOTE_SYMBOL_MISSING")
      }

      const evaluatedAtDate = now()
      const evaluatedAtMilliseconds = evaluatedAtDate.getTime()
      if (!Number.isFinite(evaluatedAtMilliseconds)) {
        return failure("EVALUATION_TIME_INVALID")
      }

      const evaluatedAt = evaluatedAtDate.toISOString()
      const evaluatedAtNanoseconds =
        BigInt(evaluatedAtMilliseconds) * 1_000_000n
      const longQuote = parseQuote(
        longContractSymbol,
        longSnapshot.latestQuote,
        evaluatedAtNanoseconds,
      )
      if (!longQuote.success) return failure(longQuote.reason)

      const shortQuote = parseQuote(
        shortContractSymbol,
        shortSnapshot.latestQuote,
        evaluatedAtNanoseconds,
      )
      if (!shortQuote.success) return failure(shortQuote.reason)

      const freshUntilNanoseconds =
        longQuote.freshUntilNanoseconds < shortQuote.freshUntilNanoseconds
          ? longQuote.freshUntilNanoseconds
          : shortQuote.freshUntilNanoseconds

      return {
        success: true,
        snapshot: {
          evaluatedAt,
          snapshotMetadata: {
            provider: "ALPACA",
            source: "options-snapshots-indicative",
            retrievedAt: evaluatedAt,
            freshUntil:
              floorNanosecondsToIsoMilliseconds(freshUntilNanoseconds),
          },
          longQuote: longQuote.quote,
          shortQuote: shortQuote.quote,
        },
      }
    },
  }
}
