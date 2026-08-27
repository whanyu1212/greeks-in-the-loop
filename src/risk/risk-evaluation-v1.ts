import { z } from "zod"

import { tradeIntentV1Schema } from "../contracts/trade-intent-v1.js"
import { researchEligibilityV1Schema } from "../scheduling/research-eligibility.js"
import { parseRfc3339Nanoseconds } from "../shared/value-normalization.js"

export const RISK_EVALUATION_VERSION = "1.0.0" as const
export const RISK_RULE_VERSION = "1.0.0" as const

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
  "LIQUIDITY_INELIGIBLE",
  "ENTRY_PRICE_INELIGIBLE",
  "MAX_LOSS_EXCEEDED",
  "ACCOUNT_INELIGIBLE",
  "RECONCILIATION_INCONSISTENT",
  "EXPOSURE_LIMIT_ACTIVE",
  "DAILY_ENTRY_LIMIT_ACTIVE",
  "BUYING_POWER_RESERVE_INSUFFICIENT",
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
const MAX_LOSS_CENTS = 50_000
const DAILY_DRAWDOWN_CENTS = 150_000
const COMPETITION_BREAKER_EQUITY_CENTS = 9_250_000

const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const nonnegativeSafeInteger = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const positiveSafeInteger = nonnegativeSafeInteger.positive()
const count = z.number().int().nonnegative().max(1_000_000)
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

export type RiskContractLegV1 = Readonly<
  z.infer<typeof riskContractLegV1Schema>
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

export const riskEvaluationInputV1Schema = z
  .object({
    intent: tradeIntentV1Schema,
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

const approvedRiskEvaluationV1Schema = z
  .object({
    evaluationVersion: z.literal(RISK_EVALUATION_VERSION),
    ruleVersion: z.literal(RISK_RULE_VERSION),
    outcome: z.literal("APPROVED"),
    evaluatedAt: timestamp,
    approvedQuantity: z.literal(1),
    maxLossCents: positiveSafeInteger,
    projectedBuyingPowerCents: nonnegativeSafeInteger,
  })
  .strict()

const rejectedRiskEvaluationV1Schema = z
  .object({
    evaluationVersion: z.literal(RISK_EVALUATION_VERSION),
    ruleVersion: z.literal(RISK_RULE_VERSION),
    outcome: z.literal("REJECTED"),
    evaluatedAt: timestamp.nullable(),
    reasonCodes: z.array(z.enum(RISK_REJECTION_CODES)).min(1),
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
export function evaluateTradeIntentRiskV1(input: unknown): RiskEvaluationV1 {
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

  if (
    quoteIsTooWide(
      intent.longQuote.bidCentsPerShare,
      intent.longQuote.askCentsPerShare,
    ) ||
    quoteIsTooWide(
      intent.shortQuote.bidCentsPerShare,
      intent.shortQuote.askCentsPerShare,
    )
  ) {
    liquidityIneligible = true
  }
  if (liquidityIneligible) {
    reject("LIQUIDITY_INELIGIBLE")
  }

  if (
    BigInt(intent.entryLimitCentsPerShare) * 100n >
    BigInt(intent.widthCentsPerShare) * 60n
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

  const projectedBuyingPower =
    BigInt(account.buyingPowerCents) -
    BigInt(intent.maxLossCentsPerContract)
  if (
    projectedBuyingPower < 0n ||
    projectedBuyingPower * 2n < BigInt(account.buyingPowerCents)
  ) {
    reject("BUYING_POWER_RESERVE_INSUFFICIENT")
  }

  if (
    portfolio.dailyBreakerActive ||
    BigInt(account.lastEquityCents) - BigInt(account.equityCents) >=
      BigInt(DAILY_DRAWDOWN_CENTS)
  ) {
    reject("DAILY_BREAKER_ACTIVE")
  }
  if (
    portfolio.competitionBreakerActive ||
    account.equityCents <= COMPETITION_BREAKER_EQUITY_CENTS
  ) {
    reject("COMPETITION_BREAKER_ACTIVE")
  }

  if (reasons.length > 0) {
    return {
      evaluationVersion: RISK_EVALUATION_VERSION,
      ruleVersion: RISK_RULE_VERSION,
      outcome: "REJECTED",
      evaluatedAt: eligibility.evaluatedAt,
      reasonCodes: reasons,
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
  }
}
