import { z } from "zod"

import { tradeIntentV3Schema } from "../contracts/trade-intent-v3.js"
import { tradeIntentV4Schema } from "../contracts/trade-intent-v4.js"
import { alpacaMinimumLevelFor } from "../options/alpaca-capabilities.js"
import { researchEligibilityV1Schema } from "../scheduling/research-eligibility.js"
import { parseAlpacaOptionSymbol } from "../shared/alpaca-option-identity.js"
import { deriveOptionLegAggregateGreeksV1 } from "../shared/option-leg-aggregate-greeks.js"
import { parseRfc3339Nanoseconds } from "../shared/value-normalization.js"
import {
  deriveVerticalSpreadGreeksV1,
  verticalSpreadGreeksV1Schema,
} from "../shared/vertical-spread-greeks.js"
import {
  deriveStrategyEconomicsV1,
  strategyEconomicsV1Schema,
} from "./strategy-economics-v1.js"

export const RISK_EVALUATION_VERSION = "1.0.0" as const
export const RISK_RULE_VERSION = "2.0.0" as const
const LEGACY_RISK_RULE_VERSION = "1.2.0" as const
export const SUPPORTED_RISK_RULE_VERSIONS = [
  "1.0.0",
  "1.1.0",
  "1.2.0",
  RISK_RULE_VERSION,
] as const

export const RISK_REJECTION_CODES = [
  "RISK_INPUT_INVALID",
  "MARKET_WINDOW_INELIGIBLE",
  "MARKET_DATA_STALE",
  "SNAPSHOT_INTEGRITY_INVALID",
  "ACCOUNT_STATE_STALE",
  "RECONCILIATION_STATE_STALE",
  "CONTRACT_IDENTITY_MISMATCH",
  "CONTRACT_INELIGIBLE",
  "EXPIRATION_INELIGIBLE",
  "SPREAD_WIDTH_INELIGIBLE",
  "CONTRACT_METRICS_INELIGIBLE",
  "SPREAD_GREEKS_INELIGIBLE",
  "LIQUIDITY_INELIGIBLE",
  "ENTRY_PRICE_INELIGIBLE",
  "MAX_LOSS_EXCEEDED",
  "STRATEGY_ECONOMICS_INELIGIBLE",
  "OPTIONS_APPROVAL_INSUFFICIENT",
  "COLLATERAL_INSUFFICIENT",
  "ACCOUNT_INELIGIBLE",
  "RECONCILIATION_INCONSISTENT",
  "EXPOSURE_LIMIT_ACTIVE",
  "DAILY_ENTRY_LIMIT_ACTIVE",
  "BUYING_POWER_RESERVE_INSUFFICIENT",
  "DAILY_LOSS_BUDGET_INSUFFICIENT",
  "COMPETITION_LOSS_BUDGET_INSUFFICIENT",
  "DAILY_BREAKER_ACTIVE",
  "COMPETITION_BREAKER_ACTIVE",
] as const

export type RiskRejectionCode = (typeof RISK_REJECTION_CODES)[number]

const QUOTE_AND_CONTRACT_MAX_AGE_NANOSECONDS = 60_000_000_000n
const ACCOUNT_AND_RECONCILIATION_MAX_AGE_MS = 5 * 60_000
const MIN_DTE = 14
const MAX_DTE = 30
const MIN_SPREAD_WIDTH_CENTS = 100
const MAX_SPREAD_WIDTH_CENTS = 1_000
const MAX_LEG_QUOTE_WIDTH_CENTS = 20
const MIN_VOLUME = 100
const MIN_OPEN_INTEREST = 500
export const MIN_DIRECTIONAL_NET_DELTA = 0.1
export const MAX_DIRECTIONAL_NET_DELTA = 0.4
const MAX_LOSS_CENTS = 50_000
const DAILY_DRAWDOWN_CENTS = 150_000
const COMPETITION_BREAKER_EQUITY_CENTS = 9_250_000
const MAX_GENERIC_DIRECTIONAL_NET_DELTA = 0.7
/**
 * Symmetric net-delta bound for structures whose thesis is not directional.
 *
 * A neutral or volatility structure carrying material net delta is a
 * directional bet wearing a volatility label. Until this bound existed no
 * layer objected: the screen never tested direction for these outlooks, and
 * the directional band below applies only to BULLISH and BEARISH intents.
 */
export const MAX_NONDIRECTIONAL_ABSOLUTE_NET_DELTA = 0.15

const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const riskRuleVersion = z.enum(SUPPORTED_RISK_RULE_VERSIONS)
const nonnegativeSafeInteger = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const positiveSafeInteger = nonnegativeSafeInteger.positive()
const count = z.number().int().nonnegative().max(1_000_000)
// Deliberately provider-neutral: pure risk state treats broker symbols as
// bounded identities. The strategy intent and exact leg comparison own admission.
const contractSymbol = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Z0-9]{1,6}\d{6}[CP]\d{8}$/u)

export const riskContractLegV1Schema = z
  .object({
    role: z.enum(["LONG", "SHORT"]),
    contractSymbol,
    active: z.boolean(),
    tradable: z.boolean(),
    exerciseStyle: z.enum(["AMERICAN", "EUROPEAN", "UNKNOWN"]),
    multiplier: positiveSafeInteger,
    delta: z.number().finite(),
    impliedVolatility: z.number().finite(),
    gamma: z.number().finite(),
    theta: z.number().finite(),
    vega: z.number().finite(),
    volume: count,
    volumeDate: z.iso.date(),
    openInterest: count,
    openInterestDate: z.iso.date(),
  })
  .strict()

export const riskContractLegV2Schema = z
  .object({
    contractSymbol,
    positionIntent: z.enum(["BUY_TO_OPEN", "SELL_TO_OPEN"]),
    ratioQuantity: positiveSafeInteger,
    active: z.boolean(),
    tradable: z.boolean(),
    exerciseStyle: z.enum(["AMERICAN", "EUROPEAN", "UNKNOWN"]),
    multiplier: positiveSafeInteger,
    delta: z.number().finite(),
    impliedVolatility: z.number().finite(),
    gamma: z.number().finite(),
    theta: z.number().finite(),
    vega: z.number().finite(),
    volume: count,
    volumeDate: z.iso.date(),
    openInterest: count,
    openInterestDate: z.iso.date(),
  })
  .strict()

export const applicationVerifiedAccountV1Schema = z
  .object({
    observedAt: timestamp,
    status: z.enum(["ACTIVE", "INACTIVE", "UNKNOWN"]),
    tradingRestricted: z.boolean(),
    multilegOptionsApproved: z.boolean(),
    buyingPowerCents: nonnegativeSafeInteger,
    equityCents: nonnegativeSafeInteger,
    lastEquityCents: nonnegativeSafeInteger,
  })
  .strict()

export const reconciledPortfolioV1Schema = z
  .object({
    observedAt: timestamp,
    consistent: z.boolean(),
    openStrategyPositionCount: count,
    pendingEntryCount: count,
    entriesSubmittedToday: count,
    dailyBreakerActive: z.boolean(),
    competitionBreakerActive: z.boolean(),
  })
  .strict()

export const contractSnapshotV1Schema = z
  .object({
    slotStartedAt: timestamp,
    observedAt: timestamp,
    legs: z.array(riskContractLegV1Schema).length(2),
  })
  .strict()
  .superRefine((snapshot, refinement) => {
    for (const role of ["LONG", "SHORT"] as const) {
      if (snapshot.legs.filter((leg) => leg.role === role).length !== 1) {
        refinement.addIssue({
          code: "custom",
          path: ["legs"],
          message: `Contract snapshot requires exactly one ${role} leg`,
        })
      }
    }
  })

export const contractSnapshotV2Schema = z
  .object({
    snapshotVersion: z.literal("2.0.0"),
    slotStartedAt: timestamp,
    observedAt: timestamp,
    legs: z.array(riskContractLegV2Schema).min(1).max(4),
  })
  .strict()
  .superRefine((snapshot, refinement) => {
    if (
      new Set(snapshot.legs.map(({ contractSymbol }) => contractSymbol)).size !==
        snapshot.legs.length
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["legs"],
        message: "Contract snapshot legs must be unique",
      })
    }
  })

export type RiskContractLegV1 = Readonly<
  z.infer<typeof riskContractLegV1Schema>
>
export type RiskContractLegV2 = Readonly<
  z.infer<typeof riskContractLegV2Schema>
>
export type ApplicationVerifiedAccountV1 = Readonly<
  z.infer<typeof applicationVerifiedAccountV1Schema>
>
export type ReconciledPortfolioV1 = Readonly<
  z.infer<typeof reconciledPortfolioV1Schema>
>
export type ContractSnapshotV1 = Readonly<
  z.infer<typeof contractSnapshotV1Schema>
>
export type ContractSnapshotV2 = Readonly<
  Omit<z.infer<typeof contractSnapshotV2Schema>, "legs"> & {
    legs: readonly RiskContractLegV2[]
  }
>

export const riskEvaluationInputV1Schema = z
  .object({
    intent: tradeIntentV3Schema,
    context: z
      .object({
        provenance: z.literal("APPLICATION_VERIFIED"),
        eligibility: researchEligibilityV1Schema,
        account: applicationVerifiedAccountV1Schema,
        portfolio: reconciledPortfolioV1Schema,
        contracts: contractSnapshotV1Schema,
      })
      .strict(),
  })
  .strict()

export type RiskEvaluationInputV1 = Readonly<
  z.infer<typeof riskEvaluationInputV1Schema>
>

const applicationVerifiedAccountV2RiskSchema = applicationVerifiedAccountV1Schema
  .omit({ multilegOptionsApproved: true })
  .extend({
    snapshotVersion: z.literal("2.0.0"),
    optionsApprovedLevel: count,
    optionsTradingLevel: count,
    multilegOptionsApproved: z.boolean(),
    cashCents: z.number().int().safe(),
  })
  .strict()
  .superRefine((account, refinement) => {
    if (
      account.multilegOptionsApproved !==
        (account.optionsApprovedLevel >= 3 && account.optionsTradingLevel >= 3)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["multilegOptionsApproved"],
        message: "Multileg approval must match the captured option levels",
      })
    }
  })

const candidateCollateralV1RiskSchema = z
  .object({
    underlying: z.string().min(1).max(12),
    longUnderlyingShares: z.number().finite().nonnegative(),
    cashAvailableCents: nonnegativeSafeInteger,
    requiredLongSharesPerUnit: count,
    requiredCashCentsPerUnit: nonnegativeSafeInteger,
    maxUnitsFromShares: count.nullable(),
    maxUnitsFromCash: count.nullable(),
  })
  .strict()

export const riskEvaluationInputV2Schema = z
  .object({
    intent: tradeIntentV4Schema,
    context: z
      .object({
        provenance: z.literal("APPLICATION_VERIFIED"),
        eligibility: researchEligibilityV1Schema,
        account: applicationVerifiedAccountV2RiskSchema,
        candidateCollateral: candidateCollateralV1RiskSchema,
        portfolio: reconciledPortfolioV1Schema,
        contracts: contractSnapshotV2Schema,
      })
      .strict(),
  })
  .strict()

const approvedRiskEvaluationV1Schema = z
  .object({
    evaluationVersion: z.literal(RISK_EVALUATION_VERSION),
    ruleVersion: riskRuleVersion,
    outcome: z.literal("APPROVED"),
    evaluatedAt: timestamp,
    approvedQuantity: z.literal(1),
    maxLossCents: nonnegativeSafeInteger,
    projectedBuyingPowerCents: nonnegativeSafeInteger,
    // Optional only so stored rule 1.0/1.1 decisions remain readable.
    spreadGreeks: verticalSpreadGreeksV1Schema.optional(),
    aggregateGreeks: z
      .object({
        calculation: z.literal("POSITION_WEIGHTED_SUM"),
        netDelta: z.number().finite(),
        netGamma: z.number().finite(),
        netTheta: z.number().finite(),
        netVega: z.number().finite(),
      })
      .strict()
      .optional(),
    strategyEconomics: strategyEconomicsV1Schema.optional(),
  })
  .strict()

const rejectedRiskEvaluationV1Schema = z
  .object({
    evaluationVersion: z.literal(RISK_EVALUATION_VERSION),
    ruleVersion: riskRuleVersion,
    outcome: z.literal("REJECTED"),
    evaluatedAt: timestamp.nullable(),
    reasonCodes: z.array(z.enum(RISK_REJECTION_CODES)).min(1),
    // Input-invalid decisions cannot derive Greeks; older decisions predate them.
    spreadGreeks: verticalSpreadGreeksV1Schema.optional(),
    aggregateGreeks: z
      .object({
        calculation: z.literal("POSITION_WEIGHTED_SUM"),
        netDelta: z.number().finite(),
        netGamma: z.number().finite(),
        netTheta: z.number().finite(),
        netVega: z.number().finite(),
      })
      .strict()
      .optional(),
    strategyEconomics: strategyEconomicsV1Schema.optional(),
  })
  .strict()

export const riskEvaluationV1Schema = z.discriminatedUnion("outcome", [
  approvedRiskEvaluationV1Schema,
  rejectedRiskEvaluationV1Schema,
])

export type RiskEvaluationV1 = Readonly<
  z.infer<typeof riskEvaluationV1Schema>
>

const millisecondsBetweenDates = (startDate: string, endDate: string) =>
  Date.parse(`${endDate}T00:00:00.000Z`) -
  Date.parse(`${startDate}T00:00:00.000Z`)

const ageIsInvalid = (observedAt: string, evaluatedAt: number, maxAge: number) => {
  const observed = Date.parse(observedAt)
  return observed > evaluatedAt || evaluatedAt - observed > maxAge
}

const timestampAfter = (candidate: string, boundary: string) => {
  const candidateNanoseconds = parseRfc3339Nanoseconds(candidate)
  const boundaryNanoseconds = parseRfc3339Nanoseconds(boundary)
  return (
    candidateNanoseconds === undefined ||
    boundaryNanoseconds === undefined ||
    candidateNanoseconds > boundaryNanoseconds
  )
}

const timestampsEqual = (left: string, right: string) => {
  const leftNanoseconds = parseRfc3339Nanoseconds(left)
  const rightNanoseconds = parseRfc3339Nanoseconds(right)
  return (
    leftNanoseconds !== undefined &&
    rightNanoseconds !== undefined &&
    leftNanoseconds === rightNanoseconds
  )
}

const timestampAgeIsInvalid = (
  observedAt: string,
  evaluatedAt: string,
  maxAgeNanoseconds: bigint,
) => {
  const observedNanoseconds = parseRfc3339Nanoseconds(observedAt)
  const evaluatedNanoseconds = parseRfc3339Nanoseconds(evaluatedAt)
  return (
    observedNanoseconds === undefined ||
    evaluatedNanoseconds === undefined ||
    observedNanoseconds > evaluatedNanoseconds ||
    evaluatedNanoseconds - observedNanoseconds > maxAgeNanoseconds
  )
}

const quoteIsTooWide = (bidCents: number, askCents: number) => {
  const width = BigInt(askCents - bidCents)
  return (
    width > BigInt(MAX_LEG_QUOTE_WIDTH_CENTS) ||
    width * 20n > BigInt(bidCents) + BigInt(askCents)
  )
}

/**
 * Deterministically evaluates one non-executable intent against normalized,
 * application-verified state. This function performs no I/O and grants no
 * broker authority.
 */
function evaluateLegacyTradeIntentRiskV1(input: unknown): RiskEvaluationV1 {
  const parsed = riskEvaluationInputV1Schema.safeParse(input)
  if (!parsed.success) {
    return {
      evaluationVersion: RISK_EVALUATION_VERSION,
      ruleVersion: RISK_RULE_VERSION,
      outcome: "REJECTED",
      evaluatedAt: null,
      reasonCodes: ["RISK_INPUT_INVALID"],
    }
  }

  const { intent, context } = parsed.data
  const { eligibility, account, portfolio, contracts } = context
  const evaluatedAt = Date.parse(eligibility.evaluatedAt)
  const reasons: RiskRejectionCode[] = []
  const reject = (reason: RiskRejectionCode) => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }

  const tradeWindow = eligibility.tradeIntentWindow
  if (
    !eligibility.tradeIntentEligible ||
    eligibility.sessionDate === undefined ||
    tradeWindow === undefined ||
    evaluatedAt < Date.parse(tradeWindow.slotStartedAt) ||
    evaluatedAt >= Date.parse(tradeWindow.deadline)
  ) {
    reject("MARKET_WINDOW_INELIGIBLE")
  }

  if (
    timestampAfter(intent.evaluatedAt, eligibility.evaluatedAt) ||
    timestampAgeIsInvalid(
      intent.longQuote.providerTimestamp,
      eligibility.evaluatedAt,
      QUOTE_AND_CONTRACT_MAX_AGE_NANOSECONDS,
    ) ||
    timestampAgeIsInvalid(
      intent.shortQuote.providerTimestamp,
      eligibility.evaluatedAt,
      QUOTE_AND_CONTRACT_MAX_AGE_NANOSECONDS,
    ) ||
    timestampAgeIsInvalid(
      contracts.observedAt,
      eligibility.evaluatedAt,
      QUOTE_AND_CONTRACT_MAX_AGE_NANOSECONDS,
    )
  ) {
    reject("MARKET_DATA_STALE")
  }
  const snapshotFallsWithinTradeWindow =
    tradeWindow !== undefined &&
    !timestampAfter(tradeWindow.slotStartedAt, contracts.observedAt) &&
    timestampAfter(tradeWindow.deadline, contracts.observedAt)
  const intentFallsWithinTradeWindow =
    tradeWindow !== undefined &&
    !timestampAfter(tradeWindow.slotStartedAt, intent.evaluatedAt) &&
    timestampAfter(tradeWindow.deadline, intent.evaluatedAt)
  if (
    tradeWindow === undefined ||
    !timestampsEqual(contracts.slotStartedAt, tradeWindow.slotStartedAt) ||
    !timestampsEqual(intent.evaluatedAt, contracts.observedAt) ||
    !snapshotFallsWithinTradeWindow ||
    !intentFallsWithinTradeWindow ||
    timestampAfter(intent.longQuote.providerTimestamp, contracts.observedAt) ||
    timestampAfter(intent.shortQuote.providerTimestamp, contracts.observedAt)
  ) {
    reject("SNAPSHOT_INTEGRITY_INVALID")
  }

  if (
    ageIsInvalid(
      account.observedAt,
      evaluatedAt,
      ACCOUNT_AND_RECONCILIATION_MAX_AGE_MS,
    )
  ) {
    reject("ACCOUNT_STATE_STALE")
  }
  if (
    ageIsInvalid(
      portfolio.observedAt,
      evaluatedAt,
      ACCOUNT_AND_RECONCILIATION_MAX_AGE_MS,
    )
  ) {
    reject("RECONCILIATION_STATE_STALE")
  }

  const longLeg = contracts.legs.find(({ role }) => role === "LONG")!
  const shortLeg = contracts.legs.find(({ role }) => role === "SHORT")!
  const spreadGreeks = deriveVerticalSpreadGreeksV1(longLeg, shortLeg)
  if (
    longLeg.contractSymbol !== intent.longContractSymbol ||
    shortLeg.contractSymbol !== intent.shortContractSymbol
  ) {
    reject("CONTRACT_IDENTITY_MISMATCH")
  }

  if (
    contracts.legs.some(
      (leg) =>
        !leg.active ||
        !leg.tradable ||
        leg.exerciseStyle !== "AMERICAN" ||
        leg.multiplier !== 100,
    )
  ) {
    reject("CONTRACT_INELIGIBLE")
  }

  let liquidityIneligible = false
  if (eligibility.sessionDate !== undefined) {
    const dte =
      millisecondsBetweenDates(eligibility.sessionDate, intent.expiration) /
      86_400_000
    if (!Number.isInteger(dte) || dte < MIN_DTE || dte > MAX_DTE) {
      reject("EXPIRATION_INELIGIBLE")
    }

    const permittedOpenInterestDates = new Set([
      eligibility.sessionDate,
      ...(eligibility.previousSessionDates?.slice(-2) ?? []),
    ])
    if (
      contracts.legs.some(
        (leg) =>
          leg.volume < MIN_VOLUME ||
          leg.volumeDate !== eligibility.sessionDate ||
          leg.openInterest < MIN_OPEN_INTEREST ||
          !permittedOpenInterestDates.has(leg.openInterestDate),
      )
    ) {
      liquidityIneligible = true
    }
  } else {
    reject("EXPIRATION_INELIGIBLE")
    liquidityIneligible = true
  }

  if (
    intent.widthCentsPerShare < MIN_SPREAD_WIDTH_CENTS ||
    intent.widthCentsPerShare > MAX_SPREAD_WIDTH_CENTS
  ) {
    reject("SPREAD_WIDTH_INELIGIBLE")
  }

  const longAbsoluteDelta = Math.abs(longLeg.delta)
  const shortAbsoluteDelta = Math.abs(shortLeg.delta)
  if (
    contracts.legs.some(({ impliedVolatility }) => impliedVolatility <= 0) ||
    longAbsoluteDelta < 0.45 ||
    longAbsoluteDelta > 0.6 ||
    shortAbsoluteDelta < 0.2 ||
    shortAbsoluteDelta > 0.35
  ) {
    reject("CONTRACT_METRICS_INELIGIBLE")
  }
  if (spreadGreeks === undefined) {
    reject("CONTRACT_METRICS_INELIGIBLE")
  } else {
    const direction = intent.direction === "BULLISH" ? 1 : -1
    const directionalNetDelta = direction * spreadGreeks.netDelta
    if (
      direction * longLeg.delta <= 0 ||
      direction * shortLeg.delta <= 0 ||
      directionalNetDelta < MIN_DIRECTIONAL_NET_DELTA ||
      directionalNetDelta > MAX_DIRECTIONAL_NET_DELTA
    ) {
      reject("SPREAD_GREEKS_INELIGIBLE")
    }
  }

  const combinedQuoteWidth =
    BigInt(intent.longQuote.askCentsPerShare) -
    BigInt(intent.longQuote.bidCentsPerShare) +
    BigInt(intent.shortQuote.askCentsPerShare) -
    BigInt(intent.shortQuote.bidCentsPerShare)
  const exactMidpointHalfDebit =
    BigInt(intent.longQuote.bidCentsPerShare) +
    BigInt(intent.longQuote.askCentsPerShare) -
    BigInt(intent.shortQuote.bidCentsPerShare) -
    BigInt(intent.shortQuote.askCentsPerShare)
  if (
    quoteIsTooWide(
      intent.longQuote.bidCentsPerShare,
      intent.longQuote.askCentsPerShare,
    ) ||
    quoteIsTooWide(
      intent.shortQuote.bidCentsPerShare,
      intent.shortQuote.askCentsPerShare,
    ) ||
    combinedQuoteWidth * 10n > exactMidpointHalfDebit
  ) {
    liquidityIneligible = true
  }
  if (liquidityIneligible) {
    reject("LIQUIDITY_INELIGIBLE")
  }

  const maximumEligibleDebitBasis = BigInt(intent.widthCentsPerShare) * 60n
  const naturalEntryDebit =
    BigInt(intent.longQuote.askCentsPerShare) -
    BigInt(intent.shortQuote.bidCentsPerShare)
  if (
    BigInt(intent.entryLimitCentsPerShare) * 100n >
      maximumEligibleDebitBasis ||
    naturalEntryDebit * 100n > maximumEligibleDebitBasis
  ) {
    reject("ENTRY_PRICE_INELIGIBLE")
  }
  if (intent.maxLossCentsPerContract > MAX_LOSS_CENTS) {
    reject("MAX_LOSS_EXCEEDED")
  }

  if (
    account.status !== "ACTIVE" ||
    account.tradingRestricted ||
    !account.multilegOptionsApproved
  ) {
    reject("ACCOUNT_INELIGIBLE")
  }
  if (!portfolio.consistent) reject("RECONCILIATION_INCONSISTENT")
  if (
    portfolio.openStrategyPositionCount > 0 ||
    portfolio.pendingEntryCount > 0
  ) {
    reject("EXPOSURE_LIMIT_ACTIVE")
  }
  if (portfolio.entriesSubmittedToday > 0) {
    reject("DAILY_ENTRY_LIMIT_ACTIVE")
  }

  const maxLoss = BigInt(intent.maxLossCentsPerContract)
  const projectedBuyingPower = BigInt(account.buyingPowerCents) - maxLoss
  if (
    projectedBuyingPower < 0n ||
    projectedBuyingPower * 2n < BigInt(account.buyingPowerCents)
  ) {
    reject("BUYING_POWER_RESERVE_INSUFFICIENT")
  }

  const currentDailyDrawdown =
    BigInt(account.lastEquityCents) - BigInt(account.equityCents)
  if (
    portfolio.dailyBreakerActive ||
    currentDailyDrawdown >= BigInt(DAILY_DRAWDOWN_CENTS)
  ) {
    reject("DAILY_BREAKER_ACTIVE")
  } else if (
    currentDailyDrawdown + maxLoss >= BigInt(DAILY_DRAWDOWN_CENTS)
  ) {
    reject("DAILY_LOSS_BUDGET_INSUFFICIENT")
  }
  if (
    portfolio.competitionBreakerActive ||
    account.equityCents <= COMPETITION_BREAKER_EQUITY_CENTS
  ) {
    reject("COMPETITION_BREAKER_ACTIVE")
  } else if (
    BigInt(account.equityCents) - maxLoss <=
    BigInt(COMPETITION_BREAKER_EQUITY_CENTS)
  ) {
    reject("COMPETITION_LOSS_BUDGET_INSUFFICIENT")
  }

  if (reasons.length > 0) {
    return {
      evaluationVersion: RISK_EVALUATION_VERSION,
      ruleVersion: RISK_RULE_VERSION,
      outcome: "REJECTED",
      evaluatedAt: eligibility.evaluatedAt,
      reasonCodes: reasons,
      ...(spreadGreeks === undefined ? {} : { spreadGreeks }),
    }
  }

  return {
    evaluationVersion: RISK_EVALUATION_VERSION,
    ruleVersion: RISK_RULE_VERSION,
    outcome: "APPROVED",
    evaluatedAt: eligibility.evaluatedAt,
    approvedQuantity: 1,
    maxLossCents: intent.maxLossCentsPerContract,
    projectedBuyingPowerCents: Number(projectedBuyingPower),
    spreadGreeks: spreadGreeks!,
  }
}

const evaluateGenericTradeIntentRiskV1 = (
  input: z.infer<typeof riskEvaluationInputV2Schema>,
): RiskEvaluationV1 => {
  const { intent, context } = input
  const {
    eligibility,
    account,
    candidateCollateral,
    portfolio,
    contracts,
  } = context
  const evaluatedAt = Date.parse(eligibility.evaluatedAt)
  const reasons: RiskRejectionCode[] = []
  const reject = (reason: RiskRejectionCode) => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }
  const tradeWindow = eligibility.tradeIntentWindow
  if (
    !eligibility.tradeIntentEligible ||
    eligibility.sessionDate === undefined ||
    tradeWindow === undefined ||
    evaluatedAt < Date.parse(tradeWindow.slotStartedAt) ||
    evaluatedAt >= Date.parse(tradeWindow.deadline)
  ) reject("MARKET_WINDOW_INELIGIBLE")

  if (
    timestampAfter(intent.evaluatedAt, eligibility.evaluatedAt) ||
    intent.legs.some(({ quote }) => timestampAgeIsInvalid(
      quote.providerTimestamp,
      eligibility.evaluatedAt,
      QUOTE_AND_CONTRACT_MAX_AGE_NANOSECONDS,
    )) ||
    timestampAgeIsInvalid(
      contracts.observedAt,
      eligibility.evaluatedAt,
      QUOTE_AND_CONTRACT_MAX_AGE_NANOSECONDS,
    )
  ) reject("MARKET_DATA_STALE")

  const snapshotFallsWithinTradeWindow = tradeWindow !== undefined &&
    !timestampAfter(tradeWindow.slotStartedAt, contracts.observedAt) &&
    timestampAfter(tradeWindow.deadline, contracts.observedAt)
  const intentFallsWithinTradeWindow = tradeWindow !== undefined &&
    !timestampAfter(tradeWindow.slotStartedAt, intent.evaluatedAt) &&
    timestampAfter(tradeWindow.deadline, intent.evaluatedAt)
  if (
    tradeWindow === undefined ||
    !timestampsEqual(contracts.slotStartedAt, tradeWindow.slotStartedAt) ||
    !timestampsEqual(intent.evaluatedAt, contracts.observedAt) ||
    !snapshotFallsWithinTradeWindow ||
    !intentFallsWithinTradeWindow ||
    intent.legs.some(({ quote }) =>
      timestampAfter(quote.providerTimestamp, contracts.observedAt)
    )
  ) reject("SNAPSHOT_INTEGRITY_INVALID")

  if (ageIsInvalid(
    account.observedAt,
    evaluatedAt,
    ACCOUNT_AND_RECONCILIATION_MAX_AGE_MS,
  )) reject("ACCOUNT_STATE_STALE")
  if (ageIsInvalid(
    portfolio.observedAt,
    evaluatedAt,
    ACCOUNT_AND_RECONCILIATION_MAX_AGE_MS,
  )) reject("RECONCILIATION_STATE_STALE")

  if (
    contracts.legs.length !== intent.legs.length ||
    contracts.legs.some((contract, index) => {
      const leg = intent.legs[index]
      return leg === undefined ||
        contract.contractSymbol !== leg.contractSymbol ||
        contract.positionIntent !== leg.positionIntent ||
        contract.ratioQuantity !== leg.ratioQuantity
    })
  ) reject("CONTRACT_IDENTITY_MISMATCH")
  if (contracts.legs.some((leg) =>
    !leg.active || !leg.tradable || leg.exerciseStyle !== "AMERICAN" ||
    leg.multiplier !== 100
  )) reject("CONTRACT_INELIGIBLE")

  const identities = intent.legs.map(({ contractSymbol }) =>
    parseAlpacaOptionSymbol(contractSymbol)
  )
  let liquidityIneligible = false
  if (
    eligibility.sessionDate === undefined ||
    identities.some((identity) => !identity.success)
  ) {
    reject("EXPIRATION_INELIGIBLE")
    liquidityIneligible = true
  } else {
    if (identities.some((identity) => {
      if (!identity.success) return true
      const dte = millisecondsBetweenDates(
        eligibility.sessionDate!,
        identity.identity.expiration,
      ) / 86_400_000
      return !Number.isInteger(dte) || dte < MIN_DTE || dte > MAX_DTE
    })) reject("EXPIRATION_INELIGIBLE")
    const permittedOpenInterestDates = new Set([
      eligibility.sessionDate,
      ...(eligibility.previousSessionDates?.slice(-2) ?? []),
    ])
    if (contracts.legs.some((leg) =>
      leg.volume < MIN_VOLUME ||
      leg.volumeDate !== eligibility.sessionDate ||
      leg.openInterest < MIN_OPEN_INTEREST ||
      !permittedOpenInterestDates.has(leg.openInterestDate)
    )) liquidityIneligible = true
  }

  const aggregateGreeks = deriveOptionLegAggregateGreeksV1(contracts.legs)
  if (
    aggregateGreeks === undefined ||
    contracts.legs.some(({ impliedVolatility }) => impliedVolatility <= 0)
  ) {
    reject("CONTRACT_METRICS_INELIGIBLE")
  } else if (intent.direction === "BULLISH" || intent.direction === "BEARISH") {
    const direction = intent.direction === "BULLISH" ? 1 : -1
    const directionalNetDelta = direction * aggregateGreeks.netDelta
    if (
      directionalNetDelta < MIN_DIRECTIONAL_NET_DELTA ||
      directionalNetDelta > MAX_GENERIC_DIRECTIONAL_NET_DELTA
    ) reject("SPREAD_GREEKS_INELIGIBLE")
  } else if (
    Math.abs(aggregateGreeks.netDelta) >
      MAX_NONDIRECTIONAL_ABSOLUTE_NET_DELTA
  ) {
    reject("SPREAD_GREEKS_INELIGIBLE")
  }

  const combinedQuoteWidth = intent.legs.reduce(
    (total, leg) => total + BigInt(leg.ratioQuantity) *
      BigInt(leg.quote.askCentsPerShare - leg.quote.bidCentsPerShare),
    0n,
  )
  if (
    intent.legs.some(({ quote }) => quoteIsTooWide(
      quote.bidCentsPerShare,
      quote.askCentsPerShare,
    )) ||
    combinedQuoteWidth * 5n > BigInt(intent.entryLimitCentsPerStrategyUnit)
  ) liquidityIneligible = true
  if (liquidityIneligible) reject("LIQUIDITY_INELIGIBLE")

  const economicsResult = deriveStrategyEconomicsV1(intent)
  const economics = economicsResult.success
    ? economicsResult.economics
    : undefined
  if (economics === undefined) reject("STRATEGY_ECONOMICS_INELIGIBLE")
  else if (economics.maxLossCents > MAX_LOSS_CENTS) reject("MAX_LOSS_EXCEEDED")

  if (account.status !== "ACTIVE" || account.tradingRestricted) {
    reject("ACCOUNT_INELIGIBLE")
  }
  const minimumLevel = alpacaMinimumLevelFor(intent.strategy)
  if (
    account.optionsApprovedLevel < minimumLevel ||
    account.optionsTradingLevel < minimumLevel ||
    (minimumLevel === 3 && !account.multilegOptionsApproved)
  ) reject("OPTIONS_APPROVAL_INSUFFICIENT")

  const requiredShares = intent.strategy === "COVERED_CALL" ||
      intent.strategy === "COLLAR"
    ? intent.legs.reduce((total, leg, index) => {
        const identity = identities[index]
        return total + (leg.positionIntent === "SELL_TO_OPEN" &&
            identity?.success === true && identity.identity.optionType === "C"
          ? leg.ratioQuantity * 100
          : 0)
      }, 0)
    : 0
  const requiredCash = intent.strategy === "CASH_SECURED_PUT"
    ? economics?.buyingPowerRequirementCents ?? 0
    : 0
  if (
    candidateCollateral.underlying !== intent.underlying ||
    candidateCollateral.requiredLongSharesPerUnit !== requiredShares ||
    candidateCollateral.requiredCashCentsPerUnit !== requiredCash ||
    (requiredShares > 0 && (candidateCollateral.maxUnitsFromShares ?? 0) < 1) ||
    (requiredCash > 0 && (candidateCollateral.maxUnitsFromCash ?? 0) < 1)
  ) reject("COLLATERAL_INSUFFICIENT")

  if (!portfolio.consistent) reject("RECONCILIATION_INCONSISTENT")
  if (portfolio.openStrategyPositionCount > 0 || portfolio.pendingEntryCount > 0) {
    reject("EXPOSURE_LIMIT_ACTIVE")
  }
  if (portfolio.entriesSubmittedToday > 0) reject("DAILY_ENTRY_LIMIT_ACTIVE")

  const maxLoss = BigInt(economics?.maxLossCents ?? 0)
  const buyingPowerRequirement = BigInt(
    economics?.buyingPowerRequirementCents ?? account.buyingPowerCents + 1,
  )
  const projectedBuyingPower = BigInt(account.buyingPowerCents) -
    buyingPowerRequirement
  if (
    projectedBuyingPower < 0n ||
    projectedBuyingPower * 2n < BigInt(account.buyingPowerCents)
  ) reject("BUYING_POWER_RESERVE_INSUFFICIENT")

  const currentDailyDrawdown = BigInt(account.lastEquityCents) -
    BigInt(account.equityCents)
  if (
    portfolio.dailyBreakerActive ||
    currentDailyDrawdown >= BigInt(DAILY_DRAWDOWN_CENTS)
  ) reject("DAILY_BREAKER_ACTIVE")
  else if (currentDailyDrawdown + maxLoss >= BigInt(DAILY_DRAWDOWN_CENTS)) {
    reject("DAILY_LOSS_BUDGET_INSUFFICIENT")
  }
  if (
    portfolio.competitionBreakerActive ||
    account.equityCents <= COMPETITION_BREAKER_EQUITY_CENTS
  ) reject("COMPETITION_BREAKER_ACTIVE")
  else if (
    BigInt(account.equityCents) - maxLoss <=
      BigInt(COMPETITION_BREAKER_EQUITY_CENTS)
  ) reject("COMPETITION_LOSS_BUDGET_INSUFFICIENT")

  if (reasons.length > 0) {
    return {
      evaluationVersion: RISK_EVALUATION_VERSION,
      ruleVersion: RISK_RULE_VERSION,
      outcome: "REJECTED",
      evaluatedAt: eligibility.evaluatedAt,
      reasonCodes: reasons,
      ...(aggregateGreeks === undefined ? {} : { aggregateGreeks }),
      ...(economics === undefined ? {} : { strategyEconomics: economics }),
    }
  }
  return {
    evaluationVersion: RISK_EVALUATION_VERSION,
    ruleVersion: RISK_RULE_VERSION,
    outcome: "APPROVED",
    evaluatedAt: eligibility.evaluatedAt,
    approvedQuantity: 1,
    maxLossCents: economics!.maxLossCents,
    projectedBuyingPowerCents: Number(projectedBuyingPower),
    aggregateGreeks: aggregateGreeks!,
    strategyEconomics: economics!,
  }
}

export function evaluateTradeIntentRiskV1(input: unknown): RiskEvaluationV1 {
  const generic = riskEvaluationInputV2Schema.safeParse(input)
  if (generic.success) return evaluateGenericTradeIntentRiskV1(generic.data)
  return {
    ...evaluateLegacyTradeIntentRiskV1(input),
    ruleVersion: LEGACY_RISK_RULE_VERSION,
  }
}
