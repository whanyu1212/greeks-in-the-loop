import { z } from "zod"

import {
  MAX_OPTION_UNIVERSE_CONTRACTS,
  MAX_REGULAR_SESSION_MINUTE_BARS,
  RESEARCH_MARKET_SNAPSHOT_CONTRACT_VERSION,
  RESEARCH_MARKET_SNAPSHOT_NORMALIZATION_VERSION,
  RESEARCH_SNAPSHOT_MAX_DTE,
  RESEARCH_SNAPSHOT_MIN_DTE,
  RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT,
  RESEARCH_SNAPSHOT_QUOTE_FRESHNESS_MS,
  computeOptionUniverseSnapshotIdV1,
  computeUnderlyingSessionSnapshotIdV1,
  optionUniverseContractV1Schema,
  optionUniverseSnapshotV1Schema,
  optionUniverseSourcesV1Schema,
  researchSnapshotStrategyManifestV1Schema,
  researchSnapshotTimesV1Schema,
  researchSnapshotUtcTimestampV1Schema,
  underlyingDailyBarV1Schema,
  underlyingMinuteBarV1Schema,
  underlyingQuoteV1Schema,
  underlyingSessionSnapshotV1Schema,
  underlyingSnapshotSourcesV1Schema,
  type OptionUniverseContractV1,
  type OptionUniverseSnapshotContentV1,
  type OptionUniverseSnapshotV1,
  type UnderlyingSessionSnapshotContentV1,
  type UnderlyingSessionSnapshotV1,
} from "./research-market-snapshot-v1.js"
import {
  alpacaOptionStrikeCents,
  parseAlpacaOptionSymbol,
  validateSpyOptionUniverseV1,
} from "../shared/alpaca-option-identity.js"
import { checkStrategyManifestCompatibility } from "../strategy/strategy-registry.js"

const calendarDate = z.iso.date()
const terminalPaginationInputSchema = z.enum([
  "NO_NEXT_PAGE_TOKEN",
  "NEXT_PAGE_TOKEN_PRESENT",
])

const underlyingSessionInputSchema = z
  .object({
    date: calendarDate,
    openAt: researchSnapshotUtcTimestampV1Schema,
    closeAt: researchSnapshotUtcTimestampV1Schema,
    previousSessionDates: z
      .array(calendarDate)
      .max(RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT),
  })
  .strict()

const underlyingSnapshotBuildInputV1Schema = z
  .object({
    strategyManifest: researchSnapshotStrategyManifestV1Schema,
    underlying: z.string().min(1).max(32),
    session: underlyingSessionInputSchema,
    times: researchSnapshotTimesV1Schema,
    sources: underlyingSnapshotSourcesV1Schema,
    pagination: z
      .object({
        dailyBars: terminalPaginationInputSchema,
        minuteBars: terminalPaginationInputSchema,
      })
      .strict(),
    dailyBars: z
      .array(underlyingDailyBarV1Schema)
      .max(RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT),
    minuteBars: z
      .array(underlyingMinuteBarV1Schema)
      .max(MAX_REGULAR_SESSION_MINUTE_BARS),
    underlyingQuote: underlyingQuoteV1Schema,
  })
  .strict()

const optionUniverseSnapshotBuildInputV1Schema = z
  .object({
    underlying: z.string().min(1).max(32),
    sources: optionUniverseSourcesV1Schema,
    contractPaginationTermination: terminalPaginationInputSchema,
    requestedContractSymbols: z
      .array(z.string().min(1).max(64))
      .max(MAX_OPTION_UNIVERSE_CONTRACTS),
    contracts: z
      .array(optionUniverseContractV1Schema)
      .max(MAX_OPTION_UNIVERSE_CONTRACTS),
  })
  .strict()

export type UnderlyingSessionSnapshotBuildInputV1 = Readonly<
  z.infer<typeof underlyingSnapshotBuildInputV1Schema>
>
export type OptionUniverseSnapshotBuildInputV1 = Readonly<
  z.infer<typeof optionUniverseSnapshotBuildInputV1Schema>
>

export const UNDERLYING_SNAPSHOT_BUILD_FAILURE_CODES = Object.freeze([
  "INPUT_INVALID",
  "STRATEGY_MANIFEST_INCOMPATIBLE",
  "UNDERLYING_MISMATCH",
  "DUPLICATE_RECORD",
  "DATA_INCOMPLETE",
  "OBSERVATION_FROM_FUTURE",
  "OBSERVATION_STALE",
  "SNAPSHOT_INVALID",
] as const)
export type UnderlyingSnapshotBuildFailureCode =
  (typeof UNDERLYING_SNAPSHOT_BUILD_FAILURE_CODES)[number]

export const OPTION_UNIVERSE_SNAPSHOT_BUILD_FAILURE_CODES = Object.freeze([
  "INPUT_INVALID",
  "UNDERLYING_SNAPSHOT_INVALID",
  "STRATEGY_MANIFEST_INCOMPATIBLE",
  "UNDERLYING_MISMATCH",
  "DUPLICATE_RECORD",
  "DATA_INCOMPLETE",
  "IDENTITY_MISMATCH",
  "OBSERVATION_FROM_FUTURE",
  "OBSERVATION_STALE",
  "SNAPSHOT_INVALID",
] as const)
export type OptionUniverseSnapshotBuildFailureCode =
  (typeof OPTION_UNIVERSE_SNAPSHOT_BUILD_FAILURE_CODES)[number]

export type UnderlyingSessionSnapshotBuildResultV1 =
  | Readonly<{ success: true; snapshot: UnderlyingSessionSnapshotV1 }>
  | Readonly<{
      success: false
      reasons: readonly UnderlyingSnapshotBuildFailureCode[]
    }>

export type OptionUniverseSnapshotBuildResultV1 =
  | Readonly<{ success: true; snapshot: OptionUniverseSnapshotV1 }>
  | Readonly<{
      success: false
      reasons: readonly OptionUniverseSnapshotBuildFailureCode[]
    }>

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key])
  }
  return Object.freeze(value)
}

const asciiCompare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0

const hasDuplicate = <T>(values: readonly T[], key: (value: T) => string) => {
  const keys = values.map(key)
  return new Set(keys).size !== keys.length
}

const isWeekday = (date: string) => {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay()
  return day >= 1 && day <= 5
}

const orderedReasons = <T extends string>(
  order: readonly T[],
  reasons: ReadonlySet<T>,
) => order.filter((reason) => reasons.has(reason))

const expectedMinuteCount = (
  openAt: string,
  closeAt: string,
  observedAt: string,
) =>
  Math.max(
    0,
    Math.floor(
      (Math.min(Date.parse(observedAt), Date.parse(closeAt)) -
        Date.parse(openAt)) /
        60_000,
    ),
  )

const futureOrStaleQuote = (
  providerTimestamp: string,
  observedAt: string,
) => {
  const provider = Date.parse(providerTimestamp)
  const observed = Date.parse(observedAt)
  return {
    future: provider > observed,
    stale: provider <= observed && observed - provider > RESEARCH_SNAPSHOT_QUOTE_FRESHNESS_MS,
  }
}

const addCalendarDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

/**
 * Builds one canonical current-strategy underlying/session snapshot without I/O.
 */
export function buildUnderlyingSessionSnapshotV1(
  input: unknown,
): UnderlyingSessionSnapshotBuildResultV1 {
  const parsed = underlyingSnapshotBuildInputV1Schema.safeParse(input)
  if (!parsed.success) return { success: false, reasons: ["INPUT_INVALID"] }

  const value = parsed.data
  const reasons = new Set<UnderlyingSnapshotBuildFailureCode>()
  const manifest = checkStrategyManifestCompatibility(value.strategyManifest)
  if (!manifest.success) reasons.add("STRATEGY_MANIFEST_INCOMPATIBLE")
  if (
    value.underlying !== "SPY" ||
    value.strategyManifest.underlying !== value.underlying
  ) {
    reasons.add("UNDERLYING_MISMATCH")
  }

  if (
    hasDuplicate(value.session.previousSessionDates, (date) => date) ||
    hasDuplicate(value.dailyBars, ({ sessionDate }) => sessionDate) ||
    hasDuplicate(value.dailyBars, ({ startedAt }) => startedAt) ||
    hasDuplicate(value.minuteBars, ({ startedAt }) => startedAt)
  ) {
    reasons.add("DUPLICATE_RECORD")
  }

  const minuteCount = expectedMinuteCount(
    value.session.openAt,
    value.session.closeAt,
    value.times.observedAt,
  )
  if (
    value.session.previousSessionDates.length !==
      RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT ||
    !isWeekday(value.session.date) ||
    value.session.previousSessionDates.some((date) => !isWeekday(date)) ||
    value.dailyBars.length !== RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT ||
    value.minuteBars.length !== minuteCount ||
    value.minuteBars.some(
      ({ startedAt }) =>
        Date.parse(startedAt) + 60_000 >
        Date.parse(value.sources.minuteBars.retrievedAt),
    ) ||
    minuteCount > MAX_REGULAR_SESSION_MINUTE_BARS ||
    value.pagination.dailyBars !== "NO_NEXT_PAGE_TOKEN" ||
    value.pagination.minuteBars !== "NO_NEXT_PAGE_TOKEN"
  ) {
    reasons.add("DATA_INCOMPLETE")
  }

  const observed = Date.parse(value.times.observedAt)
  if (
    Object.values(value.sources).some(
      ({ retrievedAt }) => Date.parse(retrievedAt) > observed,
    ) ||
    value.dailyBars.some(({ startedAt }) => Date.parse(startedAt) > observed) ||
    value.minuteBars.some(({ startedAt }) => Date.parse(startedAt) > observed)
  ) {
    reasons.add("OBSERVATION_FROM_FUTURE")
  }
  const quoteStatus = futureOrStaleQuote(
    value.underlyingQuote.providerTimestamp,
    value.times.observedAt,
  )
  if (
    quoteStatus.future ||
    Date.parse(value.underlyingQuote.providerTimestamp) >
      Date.parse(value.sources.quote.retrievedAt)
  ) {
    reasons.add("OBSERVATION_FROM_FUTURE")
  }
  if (quoteStatus.stale) reasons.add("OBSERVATION_STALE")

  if (reasons.size > 0 || !manifest.success) {
    return {
      success: false,
      reasons: orderedReasons(UNDERLYING_SNAPSHOT_BUILD_FAILURE_CODES, reasons),
    }
  }

  const previousSessionDates = [...value.session.previousSessionDates].sort(
    asciiCompare,
  )
  const dailyBars = [...value.dailyBars].sort((left, right) =>
    asciiCompare(left.sessionDate, right.sessionDate),
  )
  const minuteBars = [...value.minuteBars].sort((left, right) =>
    asciiCompare(left.startedAt, right.startedAt),
  )

  const content = {
    contractVersion: RESEARCH_MARKET_SNAPSHOT_CONTRACT_VERSION,
    normalizationVersion: RESEARCH_MARKET_SNAPSHOT_NORMALIZATION_VERSION,
    snapshotKind: "UNDERLYING_SESSION",
    strategyManifest: manifest.manifest,
    underlying: "SPY",
    session: {
      ...value.session,
      previousSessionDates,
    },
    times: value.times,
    sources: value.sources,
    completeness: {
      status: "COMPLETE",
      calendar: {
        expectedCount: RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT,
        receivedCount: RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT,
      },
      dailyBars: {
        termination: "NO_NEXT_PAGE_TOKEN",
        expectedCount: RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT,
        receivedCount: RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT,
      },
      minuteBars: {
        termination: "NO_NEXT_PAGE_TOKEN",
        expectedCount: minuteCount,
        receivedCount: minuteBars.length,
      },
      quote: { expectedCount: 1, receivedCount: 1 },
    },
    dailyBars,
    minuteBars,
    underlyingQuote: value.underlyingQuote,
  } as const satisfies UnderlyingSessionSnapshotContentV1

  const decoded = underlyingSessionSnapshotV1Schema.safeParse({
    ...content,
    snapshotId: computeUnderlyingSessionSnapshotIdV1(content),
  })
  if (!decoded.success) {
    return { success: false, reasons: ["SNAPSHOT_INVALID"] }
  }
  return { success: true, snapshot: deepFreeze(decoded.data) }
}

const contractIdentityMatches = (contract: OptionUniverseContractV1) => {
  const parsed = parseAlpacaOptionSymbol(contract.contractSymbol)
  if (!parsed.success || !validateSpyOptionUniverseV1(parsed.identity).success) {
    return false
  }
  const strike = alpacaOptionStrikeCents(parsed.identity)
  return (
    strike.success &&
    strike.strikeCentsPerShare === contract.strikeCentsPerShare &&
    parsed.identity.expiration === contract.expirationDate &&
    (parsed.identity.optionType === "C" ? "CALL" : "PUT") ===
      contract.optionType
  )
}

/**
 * Builds a canonical complete option universe linked to one current underlying
 * snapshot. It performs no provider requests or strategy eligibility filtering.
 */
export function buildOptionUniverseSnapshotV1(
  underlyingInput: unknown,
  input: unknown,
): OptionUniverseSnapshotBuildResultV1 {
  const underlying = underlyingSessionSnapshotV1Schema.safeParse(underlyingInput)
  if (!underlying.success) {
    return { success: false, reasons: ["UNDERLYING_SNAPSHOT_INVALID"] }
  }
  const parsed = optionUniverseSnapshotBuildInputV1Schema.safeParse(input)
  if (!parsed.success) return { success: false, reasons: ["INPUT_INVALID"] }

  const value = parsed.data
  const reasons = new Set<OptionUniverseSnapshotBuildFailureCode>()
  if (!checkStrategyManifestCompatibility(underlying.data.strategyManifest).success) {
    reasons.add("STRATEGY_MANIFEST_INCOMPATIBLE")
  }
  if (value.underlying !== "SPY" || underlying.data.underlying !== value.underlying) {
    reasons.add("UNDERLYING_MISMATCH")
  }
  if (
    hasDuplicate(value.requestedContractSymbols, (symbol) => symbol) ||
    hasDuplicate(value.contracts, ({ contractSymbol }) => contractSymbol)
  ) {
    reasons.add("DUPLICATE_RECORD")
  }

  const requested = [...value.requestedContractSymbols].sort(asciiCompare)
  const received = value.contracts
    .map(({ contractSymbol }) => contractSymbol)
    .sort(asciiCompare)
  if (
    value.contractPaginationTermination !== "NO_NEXT_PAGE_TOKEN" ||
    requested.length !== received.length ||
    requested.some((symbol, index) => symbol !== received[index])
  ) {
    reasons.add("DATA_INCOMPLETE")
  }
  if (value.contracts.some((contract) => !contractIdentityMatches(contract))) {
    reasons.add("IDENTITY_MISMATCH")
  }

  const observed = Date.parse(underlying.data.times.observedAt)
  if (
    Object.values(value.sources).some(
      ({ retrievedAt }) => Date.parse(retrievedAt) > observed,
    ) ||
    value.contracts.some(
      (contract) =>
        Date.parse(contract.quote.providerTimestamp) >
          Date.parse(value.sources.marketSnapshots.retrievedAt) ||
        Date.parse(contract.currentSessionVolume.providerTimestamp) >
          Date.parse(value.sources.marketSnapshots.retrievedAt) ||
        Date.parse(contract.quote.providerTimestamp) > observed ||
        Date.parse(contract.currentSessionVolume.providerTimestamp) > observed,
    )
  ) {
    reasons.add("OBSERVATION_FROM_FUTURE")
  }
  if (
    value.contracts.some(
      ({ quote }) =>
        futureOrStaleQuote(
          quote.providerTimestamp,
          underlying.data.times.observedAt,
        ).stale,
    )
  ) {
    reasons.add("OBSERVATION_STALE")
  }
  const eligibleOpenInterestDates = new Set([
    underlying.data.session.date,
    ...underlying.data.session.previousSessionDates.slice(-2),
  ])
  if (
    value.contracts.some(
      ({ openInterest }) => !eligibleOpenInterestDates.has(openInterest.asOfDate),
    )
  ) {
    reasons.add("OBSERVATION_STALE")
  }

  if (reasons.size > 0) {
    return {
      success: false,
      reasons: orderedReasons(
        OPTION_UNIVERSE_SNAPSHOT_BUILD_FAILURE_CODES,
        reasons,
      ),
    }
  }

  const contracts = [...value.contracts].sort((left, right) =>
    asciiCompare(left.contractSymbol, right.contractSymbol),
  )
  const sessionDate = underlying.data.session.date
  const content = {
    contractVersion: RESEARCH_MARKET_SNAPSHOT_CONTRACT_VERSION,
    normalizationVersion: RESEARCH_MARKET_SNAPSHOT_NORMALIZATION_VERSION,
    snapshotKind: "OPTION_UNIVERSE",
    underlyingSnapshotId: underlying.data.snapshotId,
    underlying: "SPY",
    sessionDate,
    times: underlying.data.times,
    scope: {
      dteBasis: "CALENDAR_DATES",
      minimumDte: RESEARCH_SNAPSHOT_MIN_DTE,
      maximumDte: RESEARCH_SNAPSHOT_MAX_DTE,
      expirationDateFrom: addCalendarDays(sessionDate, RESEARCH_SNAPSHOT_MIN_DTE),
      expirationDateThrough: addCalendarDays(
        sessionDate,
        RESEARCH_SNAPSHOT_MAX_DTE,
      ),
      contractStatus: "ACTIVE",
      optionTypes: ["CALL", "PUT"],
    },
    sources: value.sources,
    completeness: {
      status: "COMPLETE",
      contractPagination: {
        termination: "NO_NEXT_PAGE_TOKEN",
        receivedContractCount: contracts.length,
      },
      optionSnapshots: {
        requestedContractCount: requested.length,
        receivedContractCount: contracts.length,
      },
    },
    contracts,
  } as const satisfies OptionUniverseSnapshotContentV1

  const decoded = optionUniverseSnapshotV1Schema.safeParse({
    ...content,
    snapshotId: computeOptionUniverseSnapshotIdV1(content),
  })
  if (!decoded.success) {
    return { success: false, reasons: ["SNAPSHOT_INVALID"] }
  }
  return { success: true, snapshot: deepFreeze(decoded.data) }
}

export type ResearchSnapshotPairValidationResultV1 =
  | Readonly<{
      success: true
      underlying: UnderlyingSessionSnapshotV1
      optionUniverse: OptionUniverseSnapshotV1
    }>
  | Readonly<{
      success: false
      reason:
        | "UNDERLYING_SNAPSHOT_INVALID"
        | "OPTION_UNIVERSE_SNAPSHOT_INVALID"
        | "SNAPSHOT_LINK_MISMATCH"
    }>

/** Validates the content-addressed link before snapshots are consumed together. */
export function validateResearchSnapshotPairV1(
  underlyingInput: unknown,
  optionUniverseInput: unknown,
): ResearchSnapshotPairValidationResultV1 {
  const underlying = underlyingSessionSnapshotV1Schema.safeParse(underlyingInput)
  if (!underlying.success) {
    return { success: false, reason: "UNDERLYING_SNAPSHOT_INVALID" }
  }
  const optionUniverse = optionUniverseSnapshotV1Schema.safeParse(
    optionUniverseInput,
  )
  if (!optionUniverse.success) {
    return { success: false, reason: "OPTION_UNIVERSE_SNAPSHOT_INVALID" }
  }
  if (
    optionUniverse.data.underlyingSnapshotId !== underlying.data.snapshotId ||
    optionUniverse.data.underlying !== underlying.data.underlying ||
    optionUniverse.data.sessionDate !== underlying.data.session.date ||
    JSON.stringify(optionUniverse.data.times) !==
      JSON.stringify(underlying.data.times)
  ) {
    return { success: false, reason: "SNAPSHOT_LINK_MISMATCH" }
  }
  const eligibleOpenInterestDates = new Set([
    underlying.data.session.date,
    ...underlying.data.session.previousSessionDates.slice(-2),
  ])
  if (
    optionUniverse.data.contracts.some(
      ({ openInterest }) => !eligibleOpenInterestDates.has(openInterest.asOfDate),
    )
  ) {
    return { success: false, reason: "OPTION_UNIVERSE_SNAPSHOT_INVALID" }
  }
  return {
    success: true,
    underlying: deepFreeze(underlying.data),
    optionUniverse: deepFreeze(optionUniverse.data),
  }
}
