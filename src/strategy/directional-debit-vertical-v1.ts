import {
  calculateDebitSpreadEconomicsV1,
  type DebitSpreadEconomicsV1,
} from "../contracts/debit-spread-economics-v1.js"
import type {
  ResearchSnapshotPairValidationResultV1,
} from "../contracts/research-market-snapshot-builders-v1.js"
import type {
  OptionUniverseContractV1,
} from "../contracts/research-market-snapshot-v1.js"
import { canonicalJsonSha256 } from "../shared/canonical-json.js"
import { checkStrategyManifestCompatibility } from "./strategy-registry.js"

export const DIRECTIONAL_TREND_FEATURE_COMPONENT_ID =
  "calculateDirectionalTrendFeaturesV1" as const
export const DIRECTIONAL_TREND_FEATURE_VERSION = "1.0.0" as const
export const DEBIT_VERTICAL_CANDIDATE_COMPONENT_ID =
  "screenSpyDirectionalDebitVerticalV1" as const
export const DEBIT_VERTICAL_CANDIDATE_VERSION = "1.0.0" as const
export const DEBIT_VERTICAL_CANDIDATE_CONTRACT_VERSION = "1.0.0" as const

export type DirectionalSignalV1 = "BULLISH" | "BEARISH" | "NO_ACTION"

export type DirectionalTrendFeatureInputV1 = Readonly<{
  completedDailyClosesMicrosPerShare: readonly number[]
  completedMinuteBars: readonly Readonly<{
    vwapMicrosPerShare: number
    volume: number
  }>[]
  underlyingBidMicrosPerShare: number
  underlyingAskMicrosPerShare: number
}>

export type DirectionalTrendFeaturesV1 = Readonly<{
  dailyCloseMicrosPerShare: number
  sma20: Readonly<{ numeratorMicrosPerShare: string; denominator: 20 }>
  sma50: Readonly<{ numeratorMicrosPerShare: string; denominator: 50 }>
  sessionVwap: Readonly<{
    numeratorMicrosVolume: string
    denominatorVolume: string
  }>
  underlyingMidpoint: Readonly<{
    numeratorMicrosPerShare: string
    denominator: 2
  }>
  direction: DirectionalSignalV1
}>

export type DirectionalTrendFeatureResultV1 =
  | Readonly<{ success: true; features: DirectionalTrendFeaturesV1 }>
  | Readonly<{ success: false; reason: "FEATURE_INPUT_INVALID" }>

const isPositiveSafeInteger = (value: number) =>
  Number.isSafeInteger(value) && value > 0

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key])
  }
  return Object.freeze(value)
}

/** Calculates exact, symbol-neutral 20/50-session trend and session-VWAP features. */
export function calculateDirectionalTrendFeaturesV1(
  input: DirectionalTrendFeatureInputV1,
): DirectionalTrendFeatureResultV1 {
  const closes = input.completedDailyClosesMicrosPerShare
  if (
    closes.length !== 50 ||
    input.completedMinuteBars.length === 0 ||
    !closes.every(isPositiveSafeInteger) ||
    !input.completedMinuteBars.every(
      ({ vwapMicrosPerShare, volume }) =>
        isPositiveSafeInteger(vwapMicrosPerShare) &&
        isPositiveSafeInteger(volume),
    ) ||
    !isPositiveSafeInteger(input.underlyingBidMicrosPerShare) ||
    !isPositiveSafeInteger(input.underlyingAskMicrosPerShare) ||
    input.underlyingAskMicrosPerShare < input.underlyingBidMicrosPerShare
  ) {
    return Object.freeze({ success: false, reason: "FEATURE_INPUT_INVALID" })
  }

  const latest20 = closes.slice(-20)
  const sum20 = latest20.reduce((sum, value) => sum + BigInt(value), 0n)
  const sum50 = closes.reduce((sum, value) => sum + BigInt(value), 0n)
  const totalVolume = input.completedMinuteBars.reduce(
    (sum, { volume }) => sum + BigInt(volume),
    0n,
  )
  const weightedVwap = input.completedMinuteBars.reduce(
    (sum, { vwapMicrosPerShare, volume }) =>
      sum + BigInt(vwapMicrosPerShare) * BigInt(volume),
    0n,
  )
  const dailyClose = BigInt(closes.at(-1)!)
  const midpointNumerator =
    BigInt(input.underlyingBidMicrosPerShare) +
    BigInt(input.underlyingAskMicrosPerShare)

  const bullish =
    dailyClose * 20n > sum20 &&
    sum20 * 50n > sum50 * 20n &&
    midpointNumerator * totalVolume > weightedVwap * 2n
  const bearish =
    dailyClose * 20n < sum20 &&
    sum20 * 50n < sum50 * 20n &&
    midpointNumerator * totalVolume < weightedVwap * 2n

  return deepFreeze({
    success: true as const,
    features: {
      dailyCloseMicrosPerShare: Number(dailyClose),
      sma20: {
        numeratorMicrosPerShare: sum20.toString(),
        denominator: 20,
      },
      sma50: {
        numeratorMicrosPerShare: sum50.toString(),
        denominator: 50,
      },
      sessionVwap: {
        numeratorMicrosVolume: weightedVwap.toString(),
        denominatorVolume: totalVolume.toString(),
      },
      underlyingMidpoint: {
        numeratorMicrosPerShare: midpointNumerator.toString(),
        denominator: 2,
      },
      direction: bullish ? "BULLISH" : bearish ? "BEARISH" : "NO_ACTION",
    },
  })
}

export type DebitVerticalCandidateRankV1 = readonly [
  dteDistanceFrom21: number,
  deltaDistanceMillionths: number,
  widthCentsPerShare: number,
  expirationDate: string,
  longContractSymbol: string,
  shortContractSymbol: string,
]

export type DebitVerticalCandidateRankInputV1 = Readonly<{
  dte: number
  longDeltaMillionths: number
  shortDeltaMillionths: number
  widthCentsPerShare: number
  expirationDate: string
  longContractSymbol: string
  shortContractSymbol: string
}>

export const createDebitVerticalCandidateRankV1 = ({
  dte,
  longDeltaMillionths,
  shortDeltaMillionths,
  widthCentsPerShare,
  expirationDate,
  longContractSymbol,
  shortContractSymbol,
}: DebitVerticalCandidateRankInputV1): DebitVerticalCandidateRankV1 => [
  Math.abs(dte - 21),
  Math.abs(Math.abs(longDeltaMillionths) - 500_000) +
    Math.abs(Math.abs(shortDeltaMillionths) - 300_000),
  widthCentsPerShare,
  expirationDate,
  longContractSymbol,
  shortContractSymbol,
]

export const compareDebitVerticalCandidateRanksV1 = (
  left: DebitVerticalCandidateRankV1,
  right: DebitVerticalCandidateRankV1,
) => {
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!
    const rightValue = right[index]!
    if (leftValue < rightValue) return -1
    if (leftValue > rightValue) return 1
  }
  return 0
}

export type DebitVerticalCandidateV1 = Readonly<{
  contractVersion: typeof DEBIT_VERTICAL_CANDIDATE_CONTRACT_VERSION
  candidateId: string
  underlyingSnapshotId: string
  optionUniverseSnapshotId: string
  strategyId: string
  strategyVersion: string
  featureComponentId: typeof DIRECTIONAL_TREND_FEATURE_COMPONENT_ID
  featureVersion: typeof DIRECTIONAL_TREND_FEATURE_VERSION
  candidateComponentId: typeof DEBIT_VERTICAL_CANDIDATE_COMPONENT_ID
  candidateVersion: typeof DEBIT_VERTICAL_CANDIDATE_VERSION
  underlying: "SPY"
  direction: Exclude<DirectionalSignalV1, "NO_ACTION">
  structure: "BULL_CALL_SPREAD" | "BEAR_PUT_SPREAD"
  expirationDate: string
  dte: number
  longLeg: Readonly<{
    role: "LONG"
    contractSymbol: string
    strikeCentsPerShare: number
    deltaMillionths: number
  }>
  shortLeg: Readonly<{
    role: "SHORT"
    contractSymbol: string
    strikeCentsPerShare: number
    deltaMillionths: number
  }>
  economics: DebitSpreadEconomicsV1
  rank: DebitVerticalCandidateRankV1
}>

export type SpyDebitVerticalScreeningResultV1 =
  | Readonly<{
      status: "SELECTED"
      features: DirectionalTrendFeaturesV1
      selectedCandidate: DebitVerticalCandidateV1
      eligibleCandidateCount: number
    }>
  | Readonly<{
      status: "NO_ACTION"
      reason:
        | "SIGNAL_NOT_ACTIONABLE"
        | "MARKET_DATA_STALE"
        | "NO_ELIGIBLE_SPREAD"
      features: DirectionalTrendFeaturesV1
    }>
  | Readonly<{
      status: "NO_ACTION"
      reason: "STRATEGY_MANIFEST_INCOMPATIBLE"
    }>

export type ValidatedResearchSnapshotPairV1 = Extract<
  ResearchSnapshotPairValidationResultV1,
  { success: true }
>

const calendarDte = (sessionDate: string, expirationDate: string) =>
  (Date.parse(`${expirationDate}T00:00:00.000Z`) -
    Date.parse(`${sessionDate}T00:00:00.000Z`)) /
  86_400_000

const quoteIsFreshAt = (
  providerTimestamp: string,
  evaluatedAt: string,
  maximumAgeMs: number,
) => {
  const age = Date.parse(evaluatedAt) - Date.parse(providerTimestamp)
  return Number.isFinite(age) && age >= 0 && age <= maximumAgeMs
}

const contractIsEligibleForRole = (
  contract: OptionUniverseContractV1,
  role: "LONG" | "SHORT",
  optionType: "CALL" | "PUT",
  sessionDate: string,
  evaluatedAt: string,
) => {
  const absoluteDelta = Math.abs(contract.greeks.deltaMillionths)
  const quoteWidth =
    contract.quote.askCentsPerShare - contract.quote.bidCentsPerShare
  const dte = calendarDte(sessionDate, contract.expirationDate)
  return (
    contract.optionType === optionType &&
    Number.isSafeInteger(dte) &&
    dte >= 14 &&
    dte <= 30 &&
    contract.active &&
    contract.tradable &&
    contract.exerciseStyle === "AMERICAN" &&
    contract.multiplier === 100 &&
    (role === "LONG"
      ? absoluteDelta >= 450_000 && absoluteDelta <= 600_000
      : absoluteDelta >= 200_000 && absoluteDelta <= 350_000) &&
    contract.greeks.impliedVolatilityMillionths > 0 &&
    contract.quote.bidCentsPerShare > 0 &&
    contract.quote.askCentsPerShare > contract.quote.bidCentsPerShare &&
    quoteWidth <= 20 &&
    BigInt(quoteWidth) * 20n <=
      BigInt(contract.quote.bidCentsPerShare) +
        BigInt(contract.quote.askCentsPerShare) &&
    quoteIsFreshAt(contract.quote.providerTimestamp, evaluatedAt, 60_000) &&
    contract.currentSessionVolume.sessionDate === sessionDate &&
    contract.currentSessionVolume.contracts >= 100 &&
    contract.openInterest.contracts >= 500
  )
}

export type DebitVerticalCandidateIdentityInputV1 = Readonly<{
  underlyingSnapshotId: string
  optionUniverseSnapshotId: string
  strategyId: string
  strategyVersion: string
  featureComponentId: string
  featureVersion: string
  candidateComponentId: string
  candidateVersion: string
  underlying: "SPY"
  direction: Exclude<DirectionalSignalV1, "NO_ACTION">
  structure: "BULL_CALL_SPREAD" | "BEAR_PUT_SPREAD"
  expirationDate: string
  longLeg: Readonly<{ contractSymbol: string }>
  shortLeg: Readonly<{ contractSymbol: string }>
}>

type CandidateWithoutId = Omit<DebitVerticalCandidateV1, "candidateId">

export const computeDebitVerticalCandidateIdV1 = (
  candidate: DebitVerticalCandidateIdentityInputV1,
) =>
  canonicalJsonSha256({
    domain: "directional-debit-vertical-candidate-v1",
    underlyingSnapshotId: candidate.underlyingSnapshotId,
    optionUniverseSnapshotId: candidate.optionUniverseSnapshotId,
    strategyId: candidate.strategyId,
    strategyVersion: candidate.strategyVersion,
    featureComponentId: candidate.featureComponentId,
    featureVersion: candidate.featureVersion,
    candidateComponentId: candidate.candidateComponentId,
    candidateVersion: candidate.candidateVersion,
    underlying: candidate.underlying,
    direction: candidate.direction,
    structure: candidate.structure,
    expirationDate: candidate.expirationDate,
    longContractSymbol: candidate.longLeg.contractSymbol,
    shortContractSymbol: candidate.shortLeg.contractSymbol,
  })

const withCandidateId = (
  candidate: CandidateWithoutId,
): DebitVerticalCandidateV1 => ({
  ...candidate,
  candidateId: computeDebitVerticalCandidateIdV1(candidate),
})

/** Selects the frozen V1 rank-one SPY debit spread from one validated snapshot pair. */
export function screenSpyDirectionalDebitVerticalV1(
  pair: ValidatedResearchSnapshotPairV1,
): SpyDebitVerticalScreeningResultV1 {
  const { underlying, optionUniverse } = pair
  const compatibility = checkStrategyManifestCompatibility(
    underlying.strategyManifest,
  )
  if (!compatibility.success) {
    return Object.freeze({
      status: "NO_ACTION" as const,
      reason: "STRATEGY_MANIFEST_INCOMPATIBLE" as const,
    })
  }
  const featureResult = calculateDirectionalTrendFeaturesV1({
    completedDailyClosesMicrosPerShare: underlying.dailyBars.map(
      ({ closeMicrosPerShare }) => closeMicrosPerShare,
    ),
    completedMinuteBars: underlying.minuteBars.map(
      ({ vwapMicrosPerShare, volume }) => ({ vwapMicrosPerShare, volume }),
    ),
    underlyingBidMicrosPerShare:
      underlying.underlyingQuote.bidMicrosPerShare,
    underlyingAskMicrosPerShare:
      underlying.underlyingQuote.askMicrosPerShare,
  })
  if (!featureResult.success) {
    throw new Error("Validated research snapshots contain invalid feature inputs")
  }
  const { features } = featureResult
  if (features.direction === "NO_ACTION") {
    return deepFreeze({
      status: "NO_ACTION" as const,
      reason: "SIGNAL_NOT_ACTIONABLE" as const,
      features,
    })
  }

  const evaluatedAt = underlying.times.evaluatedAt
  const latestMinute = underlying.minuteBars.at(-1)!
  if (
    !quoteIsFreshAt(
      underlying.underlyingQuote.providerTimestamp,
      evaluatedAt,
      60_000,
    ) ||
    Date.parse(evaluatedAt) - (Date.parse(latestMinute.startedAt) + 60_000) >
      120_000
  ) {
    return deepFreeze({
      status: "NO_ACTION" as const,
      reason: "MARKET_DATA_STALE" as const,
      features,
    })
  }

  const direction = features.direction
  const optionType = direction === "BULLISH" ? "CALL" : "PUT"
  const structure =
    direction === "BULLISH" ? "BULL_CALL_SPREAD" : "BEAR_PUT_SPREAD"
  const longs = optionUniverse.contracts.filter((contract) =>
    contractIsEligibleForRole(
      contract,
      "LONG",
      optionType,
      underlying.session.date,
      evaluatedAt,
    ),
  )
  const shorts = optionUniverse.contracts.filter((contract) =>
    contractIsEligibleForRole(
      contract,
      "SHORT",
      optionType,
      underlying.session.date,
      evaluatedAt,
    ),
  )

  let eligibleCandidateCount = 0
  let selected: CandidateWithoutId | undefined
  // ponytail: bounded quadratic scan; index by expiration/strike only if measured chains make it material.
  for (const long of longs) {
    for (const short of shorts) {
      if (
        long.expirationDate !== short.expirationDate ||
        (optionType === "CALL"
          ? long.strikeCentsPerShare >= short.strikeCentsPerShare
          : long.strikeCentsPerShare <= short.strikeCentsPerShare)
      ) {
        continue
      }
      const widthCentsPerShare = Math.abs(
        long.strikeCentsPerShare - short.strikeCentsPerShare,
      )
      if (widthCentsPerShare < 100 || widthCentsPerShare > 1_000) continue

      const calculation = calculateDebitSpreadEconomicsV1(
        long.quote,
        short.quote,
        long.strikeCentsPerShare,
        short.strikeCentsPerShare,
      )
      if (
        !calculation.success ||
        calculation.economics.entryLimitCentsPerShare * 5 >
          widthCentsPerShare * 3 ||
        calculation.economics.maxLossCentsPerContract > 50_000
      ) {
        continue
      }

      const dte = calendarDte(
        underlying.session.date,
        long.expirationDate,
      )
      const rank = createDebitVerticalCandidateRankV1({
        dte,
        longDeltaMillionths: long.greeks.deltaMillionths,
        shortDeltaMillionths: short.greeks.deltaMillionths,
        widthCentsPerShare,
        expirationDate: long.expirationDate,
        longContractSymbol: long.contractSymbol,
        shortContractSymbol: short.contractSymbol,
      })
      const candidate: CandidateWithoutId = {
        contractVersion: DEBIT_VERTICAL_CANDIDATE_CONTRACT_VERSION,
        underlyingSnapshotId: underlying.snapshotId,
        optionUniverseSnapshotId: optionUniverse.snapshotId,
        strategyId: compatibility.manifest.strategyId,
        strategyVersion: compatibility.manifest.strategyVersion,
        featureComponentId: DIRECTIONAL_TREND_FEATURE_COMPONENT_ID,
        featureVersion: DIRECTIONAL_TREND_FEATURE_VERSION,
        candidateComponentId: DEBIT_VERTICAL_CANDIDATE_COMPONENT_ID,
        candidateVersion: DEBIT_VERTICAL_CANDIDATE_VERSION,
        underlying: "SPY",
        direction,
        structure,
        expirationDate: long.expirationDate,
        dte,
        longLeg: {
          role: "LONG",
          contractSymbol: long.contractSymbol,
          strikeCentsPerShare: long.strikeCentsPerShare,
          deltaMillionths: long.greeks.deltaMillionths,
        },
        shortLeg: {
          role: "SHORT",
          contractSymbol: short.contractSymbol,
          strikeCentsPerShare: short.strikeCentsPerShare,
          deltaMillionths: short.greeks.deltaMillionths,
        },
        economics: calculation.economics,
        rank,
      }
      eligibleCandidateCount += 1
      if (
        selected === undefined ||
        compareDebitVerticalCandidateRanksV1(candidate.rank, selected.rank) < 0
      ) {
        selected = candidate
      }
    }
  }

  return deepFreeze(
    selected === undefined
      ? {
          status: "NO_ACTION" as const,
          reason: "NO_ELIGIBLE_SPREAD" as const,
          features,
        }
      : {
          status: "SELECTED" as const,
          features,
          selectedCandidate: withCandidateId(selected),
          eligibleCandidateCount,
        },
  )
}
