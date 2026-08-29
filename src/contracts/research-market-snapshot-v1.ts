import { z } from "zod"

import {
  alpacaOptionStrikeCents,
  parseAlpacaOptionSymbol,
  spyAlpacaOptionSymbolV1Schema,
  validateSpyOptionUniverseV1,
} from "../shared/alpaca-option-identity.js"
import { canonicalJsonSha256 } from "../shared/canonical-json.js"
import { newYorkDate } from "../scheduling/research-eligibility.js"

export const RESEARCH_MARKET_SNAPSHOT_CONTRACT_VERSION = "1.0.0" as const
export const RESEARCH_MARKET_SNAPSHOT_NORMALIZATION_VERSION = "1.0.0" as const
export const RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT = 50
export const RESEARCH_SNAPSHOT_MIN_DTE = 14
export const RESEARCH_SNAPSHOT_MAX_DTE = 30
export const MAX_OPTION_UNIVERSE_CONTRACTS = 10_000
export const MAX_REGULAR_SESSION_MINUTE_BARS = 390
export const RESEARCH_SNAPSHOT_QUOTE_FRESHNESS_MS = 60_000

const UTC_MILLISECOND_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

export const researchSnapshotUtcTimestampV1Schema = z
  .iso.datetime({ offset: true, precision: 3 })
  .regex(UTC_MILLISECOND_TIMESTAMP)
export const researchSnapshotIdV1Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)

const boundedIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const boundedVersion = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positiveSafeInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
const signedSafeInteger = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)

const componentIdentityV1Schema = z
  .object({
    componentId: boundedIdentifier,
    componentVersion: boundedVersion,
  })
  .strict()

/**
 * Registry-independent structural decoder for the complete manifest embedded in
 * a V1 snapshot. Current-manifest admission belongs to the builders.
 */
export const researchSnapshotStrategyManifestV1Schema = z
  .object({
    manifestVersion: boundedVersion,
    strategyId: boundedIdentifier,
    strategyVersion: boundedVersion,
    underlying: boundedIdentifier,
    components: z
      .object({
        universePolicy: componentIdentityV1Schema,
        featureCalculation: componentIdentityV1Schema.extend({
          authority: boundedIdentifier,
        }),
        candidateGenerationRanking: componentIdentityV1Schema.extend({
          authority: boundedIdentifier,
        }),
        intentDerivation: componentIdentityV1Schema,
        riskRule: componentIdentityV1Schema.extend({
          evaluationVersion: boundedVersion,
        }),
        exitPolicy: componentIdentityV1Schema.extend({
          availability: boundedIdentifier,
        }),
      })
      .strict(),
    researchPlanCompatibility: z
      .object({
        kind: boundedIdentifier,
        invocationVersion: boundedVersion,
        agentName: boundedIdentifier,
        promptVersion: boundedVersion,
        skillName: boundedIdentifier,
        skillVersion: boundedVersion,
        decisionContractVersion: boundedVersion,
        reportVersion: boundedVersion,
      })
      .strict(),
    replayCompatibility: z
      .object({
        kind: boundedIdentifier,
        replayVersion: boundedVersion,
        executionModelVersion: boundedVersion,
        datasetVersion: boundedVersion,
        normalizationVersion: boundedVersion,
      })
      .strict(),
  })
  .strict()

export type ResearchSnapshotStrategyManifestV1 = Readonly<
  z.infer<typeof researchSnapshotStrategyManifestV1Schema>
>

export const researchSnapshotSessionV1Schema = z
  .object({
    date: z.iso.date(),
    openAt: researchSnapshotUtcTimestampV1Schema,
    closeAt: researchSnapshotUtcTimestampV1Schema,
    previousSessionDates: z
      .array(z.iso.date())
      .length(RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT),
  })
  .strict()

export const researchSnapshotTimesV1Schema = z
  .object({
    slotStartedAt: researchSnapshotUtcTimestampV1Schema,
    captureStartedAt: researchSnapshotUtcTimestampV1Schema,
    observedAt: researchSnapshotUtcTimestampV1Schema,
    evaluatedAt: researchSnapshotUtcTimestampV1Schema,
  })
  .strict()

export type ResearchSnapshotSessionV1 = Readonly<
  z.infer<typeof researchSnapshotSessionV1Schema>
>
export type ResearchSnapshotTimesV1 = Readonly<
  z.infer<typeof researchSnapshotTimesV1Schema>
>

const retrievedSource = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({
      provider: z.literal("ALPACA"),
      retrievedAt: researchSnapshotUtcTimestampV1Schema,
      ...shape,
    })
    .strict()

export const underlyingSnapshotSourcesV1Schema = z
  .object({
    calendar: retrievedSource({ source: z.literal("MARKET_CALENDAR") }),
    dailyBars: retrievedSource({
      source: z.literal("STOCK_BARS"),
      feed: z.literal("IEX"),
      adjustment: z.literal("ALL"),
    }),
    minuteBars: retrievedSource({
      source: z.literal("STOCK_BARS"),
      feed: z.literal("IEX"),
      marketHours: z.literal("REGULAR"),
    }),
    quote: retrievedSource({
      source: z.literal("STOCK_LATEST_QUOTE"),
      feed: z.literal("IEX"),
    }),
  })
  .strict()

export const optionUniverseSourcesV1Schema = z
  .object({
    contracts: retrievedSource({ source: z.literal("OPTION_CONTRACTS") }),
    marketSnapshots: retrievedSource({
      source: z.literal("OPTION_SNAPSHOTS"),
      feed: z.literal("INDICATIVE"),
    }),
  })
  .strict()

const barPriceFields = {
  openMicrosPerShare: positiveSafeInteger,
  highMicrosPerShare: positiveSafeInteger,
  lowMicrosPerShare: positiveSafeInteger,
  closeMicrosPerShare: positiveSafeInteger,
  vwapMicrosPerShare: positiveSafeInteger,
  volume: positiveSafeInteger,
} as const

export const underlyingDailyBarV1Schema = z
  .object({
    symbol: z.literal("SPY"),
    sessionDate: z.iso.date(),
    startedAt: researchSnapshotUtcTimestampV1Schema,
    ...barPriceFields,
  })
  .strict()

export const underlyingMinuteBarV1Schema = z
  .object({
    symbol: z.literal("SPY"),
    startedAt: researchSnapshotUtcTimestampV1Schema,
    ...barPriceFields,
  })
  .strict()

export const underlyingQuoteV1Schema = z
  .object({
    symbol: z.literal("SPY"),
    providerTimestamp: researchSnapshotUtcTimestampV1Schema,
    bidMicrosPerShare: positiveSafeInteger,
    askMicrosPerShare: positiveSafeInteger,
  })
  .strict()

const terminalPaginationV1Schema = z.literal("NO_NEXT_PAGE_TOKEN")

export const underlyingSnapshotCompletenessV1Schema = z
  .object({
    status: z.literal("COMPLETE"),
    calendar: z
      .object({
        expectedCount: z.literal(RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT),
        receivedCount: z.literal(RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT),
      })
      .strict(),
    dailyBars: z
      .object({
        termination: terminalPaginationV1Schema,
        expectedCount: z.literal(RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT),
        receivedCount: z.literal(RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT),
      })
      .strict(),
    minuteBars: z
      .object({
        termination: terminalPaginationV1Schema,
        expectedCount: safeCount.max(MAX_REGULAR_SESSION_MINUTE_BARS),
        receivedCount: safeCount.max(MAX_REGULAR_SESSION_MINUTE_BARS),
      })
      .strict(),
    quote: z
      .object({ expectedCount: z.literal(1), receivedCount: z.literal(1) })
      .strict(),
  })
  .strict()

const validBarPrices = (bar: {
  openMicrosPerShare: number
  highMicrosPerShare: number
  lowMicrosPerShare: number
  closeMicrosPerShare: number
}) =>
  bar.lowMicrosPerShare <= bar.openMicrosPerShare &&
  bar.lowMicrosPerShare <= bar.closeMicrosPerShare &&
  bar.highMicrosPerShare >= bar.openMicrosPerShare &&
  bar.highMicrosPerShare >= bar.closeMicrosPerShare &&
  bar.lowMicrosPerShare <= bar.highMicrosPerShare

const ascendingUnique = (values: readonly string[]) =>
  values.every(
    (value, index) => index === 0 || values[index - 1]! < value,
  )

const isWeekday = (date: string) => {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay()
  return day >= 1 && day <= 5
}

const timeIsBetween = (value: string, start: number, end: number) => {
  const time = Date.parse(value)
  return Number.isFinite(time) && time >= start && time <= end
}

const addIssue = (
  refinement: z.core.$RefinementCtx,
  path: readonly PropertyKey[],
  message: string,
) => refinement.addIssue({ code: "custom", path: [...path], message })

const validateCommonSnapshot = (
  snapshot: {
    strategyManifest: ResearchSnapshotStrategyManifestV1
    underlying: "SPY"
    session: ResearchSnapshotSessionV1
    times: ResearchSnapshotTimesV1
    sources: Record<string, { retrievedAt: string }>
  },
  refinement: z.core.$RefinementCtx,
) => {
  const { session, times } = snapshot
  const open = Date.parse(session.openAt)
  const close = Date.parse(session.closeAt)
  const slot = Date.parse(times.slotStartedAt)
  const captureStarted = Date.parse(times.captureStartedAt)
  const observed = Date.parse(times.observedAt)
  const evaluated = Date.parse(times.evaluatedAt)

  if (
    snapshot.strategyManifest.underlying !== snapshot.underlying ||
    !Number.isFinite(open) ||
    !Number.isFinite(close) ||
    open >= close ||
    close - open > MAX_REGULAR_SESSION_MINUTE_BARS * 60_000 ||
    newYorkDate(new Date(open)) !== session.date ||
    newYorkDate(new Date(close - 1)) !== session.date
  ) {
    addIssue(refinement, ["session"], "Snapshot session identity is invalid")
  }
  if (
    !Number.isFinite(slot) ||
    !Number.isFinite(captureStarted) ||
    !Number.isFinite(observed) ||
    !Number.isFinite(evaluated) ||
    slot > captureStarted ||
    captureStarted > observed ||
    observed > evaluated ||
    newYorkDate(new Date(slot)) !== session.date ||
    newYorkDate(new Date(captureStarted)) !== session.date ||
    newYorkDate(new Date(observed)) !== session.date ||
    newYorkDate(new Date(evaluated)) !== session.date
  ) {
    addIssue(refinement, ["times"], "Snapshot time ordering is invalid")
  }
  if (
    !isWeekday(session.date) ||
    !ascendingUnique(session.previousSessionDates) ||
    session.previousSessionDates.some(
      (date) => date >= session.date || !isWeekday(date),
    )
  ) {
    addIssue(
      refinement,
      ["session", "previousSessionDates"],
      "Previous session identity is not canonical",
    )
  }
  for (const [name, source] of Object.entries(snapshot.sources)) {
    if (!timeIsBetween(source.retrievedAt, captureStarted, observed)) {
      addIssue(
        refinement,
        ["sources", name, "retrievedAt"],
        "Source retrieval time is outside the capture window",
      )
    }
  }
}

const underlyingSessionSnapshotContentV1Schema = z
  .object({
    contractVersion: z.literal(RESEARCH_MARKET_SNAPSHOT_CONTRACT_VERSION),
    normalizationVersion: z.literal(
      RESEARCH_MARKET_SNAPSHOT_NORMALIZATION_VERSION,
    ),
    snapshotKind: z.literal("UNDERLYING_SESSION"),
    strategyManifest: researchSnapshotStrategyManifestV1Schema,
    underlying: z.literal("SPY"),
    session: researchSnapshotSessionV1Schema,
    times: researchSnapshotTimesV1Schema,
    sources: underlyingSnapshotSourcesV1Schema,
    completeness: underlyingSnapshotCompletenessV1Schema,
    dailyBars: z
      .array(underlyingDailyBarV1Schema)
      .length(RESEARCH_SNAPSHOT_PREVIOUS_SESSION_COUNT),
    minuteBars: z
      .array(underlyingMinuteBarV1Schema)
      .max(MAX_REGULAR_SESSION_MINUTE_BARS),
    underlyingQuote: underlyingQuoteV1Schema,
  })
  .strict()

export type UnderlyingSessionSnapshotContentV1 = Readonly<
  z.infer<typeof underlyingSessionSnapshotContentV1Schema>
>

export const computeUnderlyingSessionSnapshotIdV1 = (
  content: UnderlyingSessionSnapshotContentV1,
) =>
  canonicalJsonSha256({
    domain: "underlying-session-snapshot-v1",
    content,
  })

export const underlyingSessionSnapshotV1Schema =
  underlyingSessionSnapshotContentV1Schema
    .extend({ snapshotId: researchSnapshotIdV1Schema })
    .strict()
    .superRefine((snapshot, refinement) => {
      validateCommonSnapshot(snapshot, refinement)
      const { session, times, completeness, dailyBars, minuteBars } = snapshot
      const open = Date.parse(session.openAt)
      const close = Date.parse(session.closeAt)
      const observed = Date.parse(times.observedAt)

      if (
        !ascendingUnique(dailyBars.map(({ sessionDate }) => sessionDate)) ||
        dailyBars.some(
          (bar, index) =>
            bar.sessionDate !== session.previousSessionDates[index] ||
            newYorkDate(new Date(bar.startedAt)) !== bar.sessionDate ||
            !validBarPrices(bar) ||
            Date.parse(bar.startedAt) > observed,
        )
      ) {
        addIssue(
          refinement,
          ["dailyBars"],
          "Daily bar coverage or values are invalid",
        )
      }

      const expectedMinuteCount = Math.max(
        0,
        Math.floor((Math.min(observed, close) - open) / 60_000),
      )
      const minuteTopologyValid =
        expectedMinuteCount <= MAX_REGULAR_SESSION_MINUTE_BARS &&
        minuteBars.length === expectedMinuteCount &&
        minuteBars.every(
          (bar, index) =>
            Date.parse(bar.startedAt) === open + index * 60_000 &&
            Date.parse(bar.startedAt) + 60_000 <=
              Date.parse(snapshot.sources.minuteBars.retrievedAt) &&
            newYorkDate(new Date(bar.startedAt)) === session.date &&
            validBarPrices(bar),
        )
      if (!minuteTopologyValid) {
        addIssue(
          refinement,
          ["minuteBars"],
          "Minute bar topology or values are invalid",
        )
      }
      if (
        completeness.minuteBars.expectedCount !== expectedMinuteCount ||
        completeness.minuteBars.receivedCount !== minuteBars.length ||
        completeness.dailyBars.receivedCount !== dailyBars.length
      ) {
        addIssue(
          refinement,
          ["completeness"],
          "Underlying completeness evidence does not match content",
        )
      }

      const quoteTime = Date.parse(snapshot.underlyingQuote.providerTimestamp)
      if (
        snapshot.underlyingQuote.askMicrosPerShare <
          snapshot.underlyingQuote.bidMicrosPerShare ||
        newYorkDate(new Date(quoteTime)) !== session.date ||
        quoteTime > observed ||
        observed - quoteTime > RESEARCH_SNAPSHOT_QUOTE_FRESHNESS_MS
      ) {
        addIssue(
          refinement,
          ["underlyingQuote"],
          "Underlying quote is invalid, future-dated, or stale",
        )
      }

      const { snapshotId: _snapshotId, ...content } = snapshot
      if (snapshot.snapshotId !== computeUnderlyingSessionSnapshotIdV1(content)) {
        addIssue(
          refinement,
          ["snapshotId"],
          "Underlying snapshot identity does not match content",
        )
      }
    })

export type UnderlyingSessionSnapshotV1 = Readonly<
  z.infer<typeof underlyingSessionSnapshotV1Schema>
>

export const optionUniverseScopeV1Schema = z
  .object({
    dteBasis: z.literal("CALENDAR_DATES"),
    minimumDte: z.literal(RESEARCH_SNAPSHOT_MIN_DTE),
    maximumDte: z.literal(RESEARCH_SNAPSHOT_MAX_DTE),
    expirationDateFrom: z.iso.date(),
    expirationDateThrough: z.iso.date(),
    contractStatus: z.literal("ACTIVE"),
    optionTypes: z.tuple([z.literal("CALL"), z.literal("PUT")]),
  })
  .strict()

export const optionUniverseContractV1Schema = z
  .object({
    contractSymbol: spyAlpacaOptionSymbolV1Schema,
    expirationDate: z.iso.date(),
    optionType: z.enum(["CALL", "PUT"]),
    strikeCentsPerShare: positiveSafeInteger,
    active: z.boolean(),
    tradable: z.boolean(),
    exerciseStyle: z.enum(["AMERICAN", "EUROPEAN", "UNKNOWN"]),
    multiplier: positiveSafeInteger,
    quote: z
      .object({
        providerTimestamp: researchSnapshotUtcTimestampV1Schema,
        bidCentsPerShare: safeCount,
        askCentsPerShare: positiveSafeInteger,
      })
      .strict(),
    greeks: z
      .object({
        deltaMillionths: signedSafeInteger.min(-1_000_000).max(1_000_000),
        gammaMillionths: signedSafeInteger,
        thetaMillionths: signedSafeInteger,
        vegaMillionths: signedSafeInteger,
        impliedVolatilityMillionths: positiveSafeInteger,
      })
      .strict(),
    currentSessionVolume: z
      .object({
        sessionDate: z.iso.date(),
        providerTimestamp: researchSnapshotUtcTimestampV1Schema,
        contracts: safeCount,
      })
      .strict(),
    openInterest: z
      .object({ asOfDate: z.iso.date(), contracts: safeCount })
      .strict(),
  })
  .strict()

export const optionUniverseCompletenessV1Schema = z
  .object({
    status: z.literal("COMPLETE"),
    contractPagination: z
      .object({
        termination: terminalPaginationV1Schema,
        receivedContractCount: safeCount.max(MAX_OPTION_UNIVERSE_CONTRACTS),
      })
      .strict(),
    optionSnapshots: z
      .object({
        requestedContractCount: safeCount.max(MAX_OPTION_UNIVERSE_CONTRACTS),
        receivedContractCount: safeCount.max(MAX_OPTION_UNIVERSE_CONTRACTS),
      })
      .strict(),
  })
  .strict()

const optionUniverseSnapshotContentV1Schema = z
  .object({
    contractVersion: z.literal(RESEARCH_MARKET_SNAPSHOT_CONTRACT_VERSION),
    normalizationVersion: z.literal(
      RESEARCH_MARKET_SNAPSHOT_NORMALIZATION_VERSION,
    ),
    snapshotKind: z.literal("OPTION_UNIVERSE"),
    underlyingSnapshotId: researchSnapshotIdV1Schema,
    underlying: z.literal("SPY"),
    sessionDate: z.iso.date(),
    times: researchSnapshotTimesV1Schema,
    scope: optionUniverseScopeV1Schema,
    sources: optionUniverseSourcesV1Schema,
    completeness: optionUniverseCompletenessV1Schema,
    contracts: z
      .array(optionUniverseContractV1Schema)
      .max(MAX_OPTION_UNIVERSE_CONTRACTS),
  })
  .strict()

export type OptionUniverseSnapshotContentV1 = Readonly<
  z.infer<typeof optionUniverseSnapshotContentV1Schema>
>

export const computeOptionUniverseSnapshotIdV1 = (
  content: OptionUniverseSnapshotContentV1,
) =>
  canonicalJsonSha256({
    domain: "option-universe-snapshot-v1",
    content,
  })

const addCalendarDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

export const optionUniverseSnapshotV1Schema = optionUniverseSnapshotContentV1Schema
  .extend({ snapshotId: researchSnapshotIdV1Schema })
  .strict()
  .superRefine((snapshot, refinement) => {
    const captureStarted = Date.parse(snapshot.times.captureStartedAt)
    const observed = Date.parse(snapshot.times.observedAt)
    const evaluated = Date.parse(snapshot.times.evaluatedAt)
    if (
      captureStarted > observed ||
      observed > evaluated ||
      snapshot.scope.expirationDateFrom !==
        addCalendarDays(snapshot.sessionDate, RESEARCH_SNAPSHOT_MIN_DTE) ||
      snapshot.scope.expirationDateThrough !==
        addCalendarDays(snapshot.sessionDate, RESEARCH_SNAPSHOT_MAX_DTE)
    ) {
      addIssue(
        refinement,
        ["times"],
        "Option snapshot time or scope identity is invalid",
      )
    }
    for (const [name, source] of Object.entries(snapshot.sources)) {
      if (!timeIsBetween(source.retrievedAt, captureStarted, observed)) {
        addIssue(
          refinement,
          ["sources", name, "retrievedAt"],
          "Option source retrieval time is outside the capture window",
        )
      }
    }

    if (!ascendingUnique(snapshot.contracts.map(({ contractSymbol }) => contractSymbol))) {
      addIssue(
        refinement,
        ["contracts"],
        "Option contracts must be unique and canonically sorted",
      )
    }
    snapshot.contracts.forEach((contract, index) => {
      const parsedIdentity = parseAlpacaOptionSymbol(contract.contractSymbol)
      const strike = parsedIdentity.success
        ? alpacaOptionStrikeCents(parsedIdentity.identity)
        : undefined
      const identityValid =
        parsedIdentity.success &&
        validateSpyOptionUniverseV1(parsedIdentity.identity).success &&
        strike?.success === true &&
        parsedIdentity.identity.expiration === contract.expirationDate &&
        (parsedIdentity.identity.optionType === "C" ? "CALL" : "PUT") ===
          contract.optionType &&
        strike.strikeCentsPerShare === contract.strikeCentsPerShare
      const quoteTime = Date.parse(contract.quote.providerTimestamp)
      const volumeTime = Date.parse(
        contract.currentSessionVolume.providerTimestamp,
      )
      if (
        !identityValid ||
        !contract.active ||
        contract.expirationDate < snapshot.scope.expirationDateFrom ||
        contract.expirationDate > snapshot.scope.expirationDateThrough ||
        contract.quote.askCentsPerShare <= contract.quote.bidCentsPerShare ||
        contract.currentSessionVolume.sessionDate !== snapshot.sessionDate ||
        newYorkDate(new Date(quoteTime)) !== snapshot.sessionDate ||
        newYorkDate(new Date(volumeTime)) !== snapshot.sessionDate ||
        contract.openInterest.asOfDate > snapshot.sessionDate
      ) {
        addIssue(
          refinement,
          ["contracts", index],
          "Option contract identity or normalized values are invalid",
        )
      }
      if (quoteTime > observed || volumeTime > observed) {
        addIssue(
          refinement,
          ["contracts", index],
          "Option observation is future-dated",
        )
      } else if (observed - quoteTime > RESEARCH_SNAPSHOT_QUOTE_FRESHNESS_MS) {
        addIssue(
          refinement,
          ["contracts", index, "quote"],
          "Option quote is stale",
        )
      }
    })

    const contractCount = snapshot.contracts.length
    if (
      snapshot.completeness.contractPagination.receivedContractCount !==
        contractCount ||
      snapshot.completeness.optionSnapshots.requestedContractCount !==
        contractCount ||
      snapshot.completeness.optionSnapshots.receivedContractCount !==
        contractCount
    ) {
      addIssue(
        refinement,
        ["completeness"],
        "Option completeness evidence does not match content",
      )
    }

    const { snapshotId: _snapshotId, ...content } = snapshot
    if (snapshot.snapshotId !== computeOptionUniverseSnapshotIdV1(content)) {
      addIssue(
        refinement,
        ["snapshotId"],
        "Option snapshot identity does not match content",
      )
    }
  })

export type OptionUniverseContractV1 = Readonly<
  z.infer<typeof optionUniverseContractV1Schema>
>
export type OptionUniverseSnapshotV1 = Readonly<
  z.infer<typeof optionUniverseSnapshotV1Schema>
>
