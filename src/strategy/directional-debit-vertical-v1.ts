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
export const DEBIT_VERTICAL_SCREENING_DIAGNOSTICS_VERSION = "1.0.0" as const

export const DEBIT_VERTICAL_FIRST_FAILURE_REASONS = Object.freeze([
  "STRATEGY_MANIFEST_INCOMPATIBLE",
  "FEATURE_SIGNAL_NOT_ACTIONABLE",
  "UNDERLYING_QUOTE_STALE",
  "LATEST_MINUTE_BAR_STALE",
  "OPTION_TYPE_MISMATCH",
  "DTE_INVALID",
  "DTE_OUT_OF_RANGE",
  "CONTRACT_INACTIVE",
  "CONTRACT_NOT_TRADABLE",
  "EXERCISE_STYLE_UNSUPPORTED",
  "MULTIPLIER_UNSUPPORTED",
  "DELTA_OUT_OF_RANGE",
  "IMPLIED_VOLATILITY_INVALID",
  "OPTION_QUOTE_NON_POSITIVE",
  "OPTION_QUOTE_CROSSED",
  "OPTION_QUOTE_WIDTH_EXCEEDED",
  "OPTION_QUOTE_RELATIVE_WIDTH_EXCEEDED",
  "OPTION_QUOTE_STALE",
  "VOLUME_SESSION_MISMATCH",
  "VOLUME_TOO_LOW",
  "OPEN_INTEREST_TOO_LOW",
  "EXPIRATION_MISMATCH",
  "STRIKE_ORDER_INVALID",
  "SPREAD_WIDTH_OUT_OF_RANGE",
  "NON_POSITIVE_NET_DEBIT",
  "ENTRY_LIMIT_NOT_BELOW_WIDTH",
  "ARITHMETIC_OVERFLOW",
  "DEBIT_RATIO_EXCEEDED",
  "MAX_LOSS_EXCEEDED",
  "NOT_RANK_ONE",
] as const)

export type DebitVerticalAuditStageV1 =
  | "COMPATIBILITY"
  | "FEATURE"
  | "FRESHNESS"
  | "ELIGIBILITY"
  | "LIQUIDITY"
  | "ECONOMICS"
  | "RANKING"
export type DebitVerticalFirstFailureReasonV1 =
  (typeof DEBIT_VERTICAL_FIRST_FAILURE_REASONS)[number]
export type DebitVerticalFirstFailureCountV1 = Readonly<{
  stage: DebitVerticalAuditStageV1
  reason: DebitVerticalFirstFailureReasonV1
  count: number
}>
export type DebitVerticalScreeningDiagnosticsV1 = Readonly<{
  diagnosticsVersion: typeof DEBIT_VERTICAL_SCREENING_DIAGNOSTICS_VERSION
  underlyingSnapshotId: string
  optionUniverseSnapshotId: string
  inputContractCount: number
  contractRoleEvaluationCount: number
  eligibleLongContractCount: number
  eligibleShortContractCount: number
  spreadPairEvaluationCount: number
  eligibleCandidateCount: number
  firstFailureCounts: readonly DebitVerticalFirstFailureCountV1[]
}>

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

export const DEBIT_VERTICAL_FIRST_FAILURE_STAGE_BY_REASON: Readonly<
  Record<DebitVerticalFirstFailureReasonV1, DebitVerticalAuditStageV1>
> = Object.freeze({
  STRATEGY_MANIFEST_INCOMPATIBLE: "COMPATIBILITY",
  FEATURE_SIGNAL_NOT_ACTIONABLE: "FEATURE",
  UNDERLYING_QUOTE_STALE: "FRESHNESS",
  LATEST_MINUTE_BAR_STALE: "FRESHNESS",
  OPTION_TYPE_MISMATCH: "ELIGIBILITY",
  DTE_INVALID: "ELIGIBILITY",
  DTE_OUT_OF_RANGE: "ELIGIBILITY",
  CONTRACT_INACTIVE: "ELIGIBILITY",
  CONTRACT_NOT_TRADABLE: "ELIGIBILITY",
  EXERCISE_STYLE_UNSUPPORTED: "ELIGIBILITY",
  MULTIPLIER_UNSUPPORTED: "ELIGIBILITY",
  DELTA_OUT_OF_RANGE: "ELIGIBILITY",
  IMPLIED_VOLATILITY_INVALID: "ELIGIBILITY",
  OPTION_QUOTE_NON_POSITIVE: "LIQUIDITY",
  OPTION_QUOTE_CROSSED: "LIQUIDITY",
  OPTION_QUOTE_WIDTH_EXCEEDED: "LIQUIDITY",
  OPTION_QUOTE_RELATIVE_WIDTH_EXCEEDED: "LIQUIDITY",
  OPTION_QUOTE_STALE: "FRESHNESS",
  VOLUME_SESSION_MISMATCH: "LIQUIDITY",
  VOLUME_TOO_LOW: "LIQUIDITY",
  OPEN_INTEREST_TOO_LOW: "LIQUIDITY",
  EXPIRATION_MISMATCH: "ELIGIBILITY",
  STRIKE_ORDER_INVALID: "ELIGIBILITY",
  SPREAD_WIDTH_OUT_OF_RANGE: "ELIGIBILITY",
  NON_POSITIVE_NET_DEBIT: "ECONOMICS",
  ENTRY_LIMIT_NOT_BELOW_WIDTH: "ECONOMICS",
  ARITHMETIC_OVERFLOW: "ECONOMICS",
  DEBIT_RATIO_EXCEEDED: "ECONOMICS",
  MAX_LOSS_EXCEEDED: "ECONOMICS",
  NOT_RANK_ONE: "RANKING",
})

const contractRoleFirstFailure = (
  contract: OptionUniverseContractV1,
  role: "LONG" | "SHORT",
  optionType: "CALL" | "PUT",
  sessionDate: string,
  evaluatedAt: string,
): DebitVerticalFirstFailureReasonV1 | undefined => {
  const absoluteDelta = Math.abs(contract.greeks.deltaMillionths)
  const quoteWidth =
    contract.quote.askCentsPerShare - contract.quote.bidCentsPerShare
  const dte = calendarDte(sessionDate, contract.expirationDate)
  if (contract.optionType !== optionType) return "OPTION_TYPE_MISMATCH"
  if (!Number.isSafeInteger(dte)) return "DTE_INVALID"
  if (dte < 14 || dte > 30) return "DTE_OUT_OF_RANGE"
  if (!contract.active) return "CONTRACT_INACTIVE"
  if (!contract.tradable) return "CONTRACT_NOT_TRADABLE"
  if (contract.exerciseStyle !== "AMERICAN") return "EXERCISE_STYLE_UNSUPPORTED"
  if (contract.multiplier !== 100) return "MULTIPLIER_UNSUPPORTED"
  if (
    role === "LONG"
      ? absoluteDelta < 450_000 || absoluteDelta > 600_000
      : absoluteDelta < 200_000 || absoluteDelta > 350_000
  ) return "DELTA_OUT_OF_RANGE"
  if (contract.greeks.impliedVolatilityMillionths <= 0) {
    return "IMPLIED_VOLATILITY_INVALID"
  }
  if (contract.quote.bidCentsPerShare <= 0) return "OPTION_QUOTE_NON_POSITIVE"
  if (contract.quote.askCentsPerShare <= contract.quote.bidCentsPerShare) {
    return "OPTION_QUOTE_CROSSED"
  }
  if (quoteWidth > 20) return "OPTION_QUOTE_WIDTH_EXCEEDED"
  if (
    BigInt(quoteWidth) * 20n >
      BigInt(contract.quote.bidCentsPerShare) +
        BigInt(contract.quote.askCentsPerShare)
  ) return "OPTION_QUOTE_RELATIVE_WIDTH_EXCEEDED"
  if (!quoteIsFreshAt(contract.quote.providerTimestamp, evaluatedAt, 60_000)) {
    return "OPTION_QUOTE_STALE"
  }
  if (contract.currentSessionVolume.sessionDate !== sessionDate) {
    return "VOLUME_SESSION_MISMATCH"
  }
  if (contract.currentSessionVolume.contracts < 100) return "VOLUME_TOO_LOW"
  if (contract.openInterest.contracts < 500) return "OPEN_INTEREST_TOO_LOW"
  return undefined
}

const pairFirstFailure = (
  long: OptionUniverseContractV1,
  short: OptionUniverseContractV1,
  optionType: "CALL" | "PUT",
): DebitVerticalFirstFailureReasonV1 | undefined => {
  if (long.expirationDate !== short.expirationDate) return "EXPIRATION_MISMATCH"
  if (
    optionType === "CALL"
      ? long.strikeCentsPerShare >= short.strikeCentsPerShare
      : long.strikeCentsPerShare <= short.strikeCentsPerShare
  ) return "STRIKE_ORDER_INVALID"
  const width = Math.abs(long.strikeCentsPerShare - short.strikeCentsPerShare)
  return width < 100 || width > 1_000
    ? "SPREAD_WIDTH_OUT_OF_RANGE"
    : undefined
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

export type SpyDebitVerticalAuditedScreeningResultV1 = Readonly<{
  result: SpyDebitVerticalScreeningResultV1
  diagnostics: DebitVerticalScreeningDiagnosticsV1
}>

/** Screens one snapshot pair and retains bounded, first-failure audit counts. */
export function screenSpyDirectionalDebitVerticalWithAuditV1(
  pair: ValidatedResearchSnapshotPairV1,
): SpyDebitVerticalAuditedScreeningResultV1 {
  const { underlying, optionUniverse } = pair
  const failureCounts = new Map<DebitVerticalFirstFailureReasonV1, number>()
  let contractRoleEvaluationCount = 0
  let eligibleLongContractCount = 0
  let eligibleShortContractCount = 0
  let spreadPairEvaluationCount = 0
  let eligibleCandidateCount = 0
  const reject = (reason: DebitVerticalFirstFailureReasonV1, count = 1) => {
    failureCounts.set(reason, (failureCounts.get(reason) ?? 0) + count)
  }
  const finish = (result: SpyDebitVerticalScreeningResultV1) => deepFreeze({
    result,
    diagnostics: {
      diagnosticsVersion: DEBIT_VERTICAL_SCREENING_DIAGNOSTICS_VERSION,
      underlyingSnapshotId: underlying.snapshotId,
      optionUniverseSnapshotId: optionUniverse.snapshotId,
      inputContractCount: optionUniverse.contracts.length,
      contractRoleEvaluationCount,
      eligibleLongContractCount,
      eligibleShortContractCount,
      spreadPairEvaluationCount,
      eligibleCandidateCount,
      firstFailureCounts: DEBIT_VERTICAL_FIRST_FAILURE_REASONS.flatMap((reason) => {
        const count = failureCounts.get(reason)
        return count === undefined
          ? []
          : [{
              stage: DEBIT_VERTICAL_FIRST_FAILURE_STAGE_BY_REASON[reason],
              reason,
              count,
            }]
      }),
    },
  })

  const compatibility = checkStrategyManifestCompatibility(
    underlying.strategyManifest,
  )
  if (!compatibility.success) {
    reject("STRATEGY_MANIFEST_INCOMPATIBLE")
    return finish({
      status: "NO_ACTION",
      reason: "STRATEGY_MANIFEST_INCOMPATIBLE",
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
    reject("FEATURE_SIGNAL_NOT_ACTIONABLE")
    return finish({ status: "NO_ACTION", reason: "SIGNAL_NOT_ACTIONABLE", features })
  }

  const evaluatedAt = underlying.times.evaluatedAt
  const latestMinute = underlying.minuteBars.at(-1)!
  if (!quoteIsFreshAt(
    underlying.underlyingQuote.providerTimestamp,
    evaluatedAt,
    60_000,
  )) {
    reject("UNDERLYING_QUOTE_STALE")
    return finish({ status: "NO_ACTION", reason: "MARKET_DATA_STALE", features })
  }
  if (
    Date.parse(evaluatedAt) - (Date.parse(latestMinute.startedAt) + 60_000) >
      120_000
  ) {
    reject("LATEST_MINUTE_BAR_STALE")
    return finish({ status: "NO_ACTION", reason: "MARKET_DATA_STALE", features })
  }

  const direction = features.direction
  const optionType = direction === "BULLISH" ? "CALL" : "PUT"
  const structure =
    direction === "BULLISH" ? "BULL_CALL_SPREAD" : "BEAR_PUT_SPREAD"
  const longs: OptionUniverseContractV1[] = []
  const shorts: OptionUniverseContractV1[] = []
  for (const contract of optionUniverse.contracts) {
    for (const role of ["LONG", "SHORT"] as const) {
      contractRoleEvaluationCount += 1
      const reason = contractRoleFirstFailure(
        contract,
        role,
        optionType,
        underlying.session.date,
        evaluatedAt,
      )
      if (reason !== undefined) {
        reject(reason)
      } else if (role === "LONG") {
        longs.push(contract)
        eligibleLongContractCount += 1
      } else {
        shorts.push(contract)
        eligibleShortContractCount += 1
      }
    }
  }

  let selected: CandidateWithoutId | undefined
  // ponytail: bounded quadratic scan; index by expiration/strike only if measured chains make it material.
  for (const long of longs) {
    for (const short of shorts) {
      spreadPairEvaluationCount += 1
      const pairFailure = pairFirstFailure(long, short, optionType)
      if (pairFailure !== undefined) {
        reject(pairFailure)
        continue
      }
      const widthCentsPerShare = Math.abs(
        long.strikeCentsPerShare - short.strikeCentsPerShare,
      )
      const calculation = calculateDebitSpreadEconomicsV1(
        long.quote,
        short.quote,
        long.strikeCentsPerShare,
        short.strikeCentsPerShare,
      )
      if (!calculation.success) {
        reject(calculation.reason)
        continue
      }
      if (
        calculation.economics.entryLimitCentsPerShare * 5 >
          widthCentsPerShare * 3
      ) {
        reject("DEBIT_RATIO_EXCEEDED")
        continue
      }
      if (calculation.economics.maxLossCentsPerContract > 50_000) {
        reject("MAX_LOSS_EXCEEDED")
        continue
      }

      const dte = calendarDte(underlying.session.date, long.expirationDate)
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
      ) selected = candidate
    }
  }

  if (eligibleCandidateCount > 1) reject("NOT_RANK_ONE", eligibleCandidateCount - 1)
  return finish(
    selected === undefined
      ? { status: "NO_ACTION", reason: "NO_ELIGIBLE_SPREAD", features }
      : {
          status: "SELECTED",
          features,
          selectedCandidate: withCandidateId(selected),
          eligibleCandidateCount,
        },
  )
}

/** Selects the frozen V1 rank-one SPY debit spread from one validated snapshot pair. */
export function screenSpyDirectionalDebitVerticalV1(
  pair: ValidatedResearchSnapshotPairV1,
): SpyDebitVerticalScreeningResultV1 {
  return screenSpyDirectionalDebitVerticalWithAuditV1(pair).result
}
