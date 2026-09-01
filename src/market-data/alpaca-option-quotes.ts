import { z } from "zod"

import type {
  ConfirmedOptionQuoteV2,
} from "../contracts/trade-intent-v3.js"
import type {
  EvidenceSnapshotMetadata,
} from "../contracts/research-decision-v3.js"
import { ALPACA_MAX_OPTION_ORDER_LEGS } from "../options/alpaca-capabilities.js"
import {
  parseAlpacaOptionSymbol,
} from "../shared/alpaca-option-identity.js"
import {
  floorNanosecondsToIsoMilliseconds,
  parseExactCents,
  parseRfc3339Nanoseconds,
} from "../shared/value-normalization.js"

export const ALPACA_OPTION_QUOTE_FRESHNESS_NANOSECONDS = 60_000_000_000n
export const ALPACA_OPTION_QUOTE_SNAPSHOT_SOURCE =
  "options-snapshots-indicative" as const

export const alpacaLatestOptionQuoteSchema = z
  .object({
    bp: z.union([z.number(), z.string()]),
    ap: z.union([z.number(), z.string()]),
    t: z.string(),
  })
  .passthrough()

const optionSnapshotSchema = z
  .object({
    latestQuote: alpacaLatestOptionQuoteSchema,
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

export type ConfirmedOptionQuoteSnapshotV2 = Readonly<{
  snapshotVersion: "2.0.0"
  evaluatedAt: string
  snapshotMetadata: EvidenceSnapshotMetadata
  quotes: readonly ConfirmedOptionQuoteV2[]
}>

/** Legacy two-leg snapshot retained for stored V1 state compatibility. */
export type ConfirmedOptionQuoteSnapshotV1 = Readonly<{
  evaluatedAt: string
  snapshotMetadata: EvidenceSnapshotMetadata
  longQuote: ConfirmedOptionQuoteV2
  shortQuote: ConfirmedOptionQuoteV2
}>

export type OptionQuoteConfirmationResultV2 =
  | {
      success: true
      snapshot: ConfirmedOptionQuoteSnapshotV2
    }
  | {
      success: false
      reasons: readonly OptionQuoteConfirmationFailureCode[]
    }

export type ConfirmOptionQuotesInputV2 = Readonly<{
  contractSymbols: readonly string[]
  signal: AbortSignal
}>

export type OptionQuoteProvider = Readonly<{
  confirmQuotes(
    input: ConfirmOptionQuotesInputV2,
  ): Promise<OptionQuoteConfirmationResultV2>
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
): OptionQuoteConfirmationResultV2 => ({
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
      (!allowCustomHost &&
        url.origin !== "https://data.alpaca.markets")
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
export const normalizeAlpacaOptionQuote = (
  contractSymbol: string,
  quote: z.infer<typeof alpacaLatestOptionQuoteSchema>,
  evaluatedAtNanoseconds: bigint,
):
  | {
      success: true
      quote: ConfirmedOptionQuoteV2
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
    providerTimestampNanoseconds + ALPACA_OPTION_QUOTE_FRESHNESS_NANOSECONDS
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
 * The adapter performs one GET request for the exact proposed symbols. It has
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
      contractSymbols,
      signal,
    }): Promise<OptionQuoteConfirmationResultV2> {
      const identities = contractSymbols.map(parseAlpacaOptionSymbol)
      if (
        contractSymbols.length < 1 ||
        contractSymbols.length > ALPACA_MAX_OPTION_ORDER_LEGS ||
        new Set(contractSymbols).size !== contractSymbols.length ||
        identities.some((identity) => !identity.success) ||
        new Set(identities.flatMap((identity) =>
          identity.success ? [identity.identity.root] : []
        )).size !== 1
      ) {
        return failure("QUOTE_SYMBOL_MISSING")
      }

      const url = new URL("/v1beta1/options/snapshots", baseUrl)
      url.searchParams.set(
        "symbols",
        contractSymbols.join(","),
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

      if (contractSymbols.some((symbol) =>
        !Object.hasOwn(parsedResponse.data.snapshots, symbol)
      )) {
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
      const normalized = contractSymbols.map((contractSymbol) => {
        const snapshot = parsedResponse.data.snapshots[contractSymbol]
        return snapshot === undefined
          ? { success: false as const, reason: "QUOTE_SYMBOL_MISSING" as const }
          : normalizeAlpacaOptionQuote(
              contractSymbol,
              snapshot.latestQuote,
              evaluatedAtNanoseconds,
            )
      })
      const rejected = normalized.find((quote) => !quote.success)
      if (rejected !== undefined) return failure(rejected.reason)
      const confirmed = normalized.filter(
        (quote): quote is Extract<(typeof normalized)[number], { success: true }> =>
          quote.success,
      )
      const freshUntilNanoseconds = confirmed.reduce(
        (earliest, quote) =>
          quote.freshUntilNanoseconds < earliest
            ? quote.freshUntilNanoseconds
            : earliest,
        confirmed[0]!.freshUntilNanoseconds,
      )

      return {
        success: true,
        snapshot: {
          snapshotVersion: "2.0.0",
          evaluatedAt,
          snapshotMetadata: {
            provider: "ALPACA",
            source: ALPACA_OPTION_QUOTE_SNAPSHOT_SOURCE,
            retrievedAt: evaluatedAt,
            freshUntil:
              floorNanosecondsToIsoMilliseconds(freshUntilNanoseconds),
          },
          quotes: confirmed.map(({ quote }) => quote),
        },
      }
    },
  }
}
