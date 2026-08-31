import { z } from "zod"

import {
  ALLOWED_OPTION_UNDERLYINGS_V1,
  allowedAlpacaOptionSymbolV1Schema,
} from "../shared/alpaca-option-identity.js"
import {
  noActionDecisionV2Schema,
  proposedTradeDecisionV2Schema,
  type ResearchDecisionV2,
} from "./research-decision-v2.js"
import {
  preliminaryResearchV2Schema,
  type PreliminaryResearchV2,
} from "./preliminary-research-v2.js"

export const RESEARCH_REPORT_VERSION = "3.0.0" as const

const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const boundedText = z.string().trim().min(1).max(2_000)
const boundedIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const positiveMetric = z.number().finite().positive()
const returnMetric = z.number().finite().min(-1).max(10)
const httpUrl = z
  .url()
  .max(2_048)
  .refine((value) => {
    const protocol = new URL(value).protocol
    return protocol === "https:" || protocol === "http:"
  }, "External evidence must use an HTTP(S) URL")

const accountChecksSchema = z
  .object({
    verification: z.literal("AGENT_REPORTED"),
    observedAt: timestamp,
    accountStatus: z.enum(["ACTIVE", "INACTIVE", "UNKNOWN"]),
    optionsTradingApproved: z.boolean(),
    conflictingStrategyExposure: z.boolean(),
  })
  .strict()

const marketRegimeSchema = z
  .object({
    verification: z.literal("AGENT_REPORTED"),
    temporalClass: z.enum(["LIVE", "DELAYED", "PRIOR_CLOSE"]),
    observedAt: timestamp,
    signal: z.enum(["BULLISH", "BEARISH", "MIXED", "UNAVAILABLE"]),
    dailyClose: positiveMetric.optional(),
    sma20: positiveMetric.optional(),
    sma50: positiveMetric.optional(),
    sessionVwap: positiveMetric.optional(),
    spotMidpoint: positiveMetric.optional(),
    dailySessionCount: z.number().int().nonnegative().max(250),
    intradayBarCount: z.number().int().nonnegative().max(1_000),
  })
  .strict()

const symbolIndicatorSchema = z
  .object({
    underlying: z.enum(ALLOWED_OPTION_UNDERLYINGS_V1),
    throughSessionDate: z.iso.date(),
    return5d: returnMetric,
    return20d: returnMetric,
    relativeStrengthRank20d: z.number().int().min(1).max(3),
    realizedVolatility20: positiveMetric,
    completedSessionVolumeRatio20: positiveMetric,
  })
  .strict()

const symbolIndicatorsSchema = z
  .array(symbolIndicatorSchema)
  .length(ALLOWED_OPTION_UNDERLYINGS_V1.length)
  .superRefine((indicators, refinement) => {
    const underlyings = new Set(indicators.map(({ underlying }) => underlying))
    const ranks = new Set(indicators.map(({ relativeStrengthRank20d }) => relativeStrengthRank20d))
    const throughDates = new Set(indicators.map(({ throughSessionDate }) => throughSessionDate))
    if (underlyings.size !== ALLOWED_OPTION_UNDERLYINGS_V1.length) {
      refinement.addIssue({
        code: "custom",
        path: [],
        message: "Symbol indicators must cover every allowed underlying exactly once",
      })
    }
    if (ranks.size !== ALLOWED_OPTION_UNDERLYINGS_V1.length) {
      refinement.addIssue({
        code: "custom",
        path: [],
        message: "Relative-strength ranks must be unique",
      })
    }
    if (throughDates.size !== 1) {
      refinement.addIssue({
        code: "custom",
        path: [],
        message: "Symbol indicators must use one completed-session cutoff",
      })
    }
    const ranked = [...indicators].sort((left, right) =>
      right.return20d - left.return20d ||
      (left.underlying === right.underlying
        ? 0
        : left.underlying < right.underlying
          ? -1
          : 1),
    )
    ranked.forEach((indicator, index) => {
      if (indicator.relativeStrengthRank20d !== index + 1) {
        refinement.addIssue({
          code: "custom",
          path: [indicators.indexOf(indicator), "relativeStrengthRank20d"],
          message: "Relative-strength rank must follow descending 20-day return",
        })
      }
    })
  })

const candidateLegAnalysisSchema = z
  .object({
    role: z.enum(["LONG", "SHORT"]),
    contractSymbol: allowedAlpacaOptionSymbolV1Schema,
    delta: z.number().finite().min(-1).max(1),
    impliedVolatility: positiveMetric,
    gamma: z.number().finite(),
    theta: z.number().finite(),
    vega: z.number().finite(),
    volume: z.number().int().nonnegative(),
    openInterest: z.number().int().nonnegative(),
    openInterestDate: z.iso.date(),
    ivToRealizedVolatility: positiveMetric.optional(),
    bidAskSpreadPercent: z.number().finite().nonnegative().max(2).optional(),
  })
  .strict()

const candidateEvaluationSchema = z
  .object({
    verification: z.literal("AGENT_REPORTED"),
    observedAt: timestamp,
    dte: z.number().int().nonnegative().max(365),
    legs: z.array(candidateLegAnalysisSchema).length(2),
  })
  .strict()
  .superRefine((evaluation, refinement) => {
    for (const role of ["LONG", "SHORT"] as const) {
      if (evaluation.legs.filter((leg) => leg.role === role).length !== 1) {
        refinement.addIssue({
          code: "custom",
          path: ["legs"],
          message: `Candidate evaluation requires exactly one ${role} leg`,
        })
      }
    }
  })

const exaContextSchema = z
  .object({
    sourceId: boundedIdentifier,
    provider: z.literal("EXA"),
    verification: z.literal("AGENT_REPORTED"),
    title: z.string().trim().min(1).max(500),
    url: httpUrl,
    publishedAt: timestamp,
    retrievedAt: timestamp,
    summary: boundedText,
    relevance: z.enum(["SUPPORTS", "CONTRADICTS", "NEUTRAL"]),
  })
  .strict()
  .refine(
    ({ publishedAt, retrievedAt }) =>
      Date.parse(publishedAt) <= Date.parse(retrievedAt),
    {
      path: ["publishedAt"],
      message: "Exa publication time cannot follow retrieval time",
    },
  )

const fmpContextSchema = z
  .object({
    sourceId: boundedIdentifier,
    provider: z.literal("FMP"),
    verification: z.literal("AGENT_REPORTED"),
    dataset: z.string().trim().min(1).max(128),
    observedAt: timestamp,
    retrievedAt: timestamp,
    summary: boundedText,
    relevance: z.enum(["SUPPORTS", "CONTRADICTS", "NEUTRAL"]),
  })
  .strict()
  .refine(
    ({ observedAt, retrievedAt }) =>
      Date.parse(observedAt) <= Date.parse(retrievedAt),
    {
      path: ["observedAt"],
      message: "FMP observation time cannot follow retrieval time",
    },
  )

const externalContextSchema = z.discriminatedUnion("provider", [
  exaContextSchema,
  fmpContextSchema,
])

const analysisSchema = z
  .object({
    provenance: z.literal("AGENT_REPORTED"),
    asOf: timestamp,
    accountChecks: accountChecksSchema,
    marketRegime: marketRegimeSchema,
    symbolIndicators: symbolIndicatorsSchema.optional(),
    candidateEvaluation: candidateEvaluationSchema.optional(),
    externalContext: z.array(externalContextSchema).max(8),
    supportingFactors: z.array(boundedText).max(12),
    contradictingFactors: z.array(boundedText).max(12),
    conflicts: z.array(boundedText).max(12),
  })
  .strict()

const resultSchema = z.discriminatedUnion("outcome", [
  noActionDecisionV2Schema,
  proposedTradeDecisionV2Schema,
  preliminaryResearchV2Schema,
])

const EXA_EXEMPT_NO_ACTION_REASONS = new Set([
  "MARKET_WINDOW_INELIGIBLE",
  "ACCOUNT_STATE_INELIGIBLE",
  "POSITION_OR_RISK_LIMIT_ACTIVE",
  "REQUIRED_EXA_EVIDENCE_UNAVAILABLE",
  "CONTRACT_UNREPRESENTABLE",
])

export const researchReportV3Schema = z
  .object({
    reportVersion: z.literal(RESEARCH_REPORT_VERSION),
    result: resultSchema,
    analysis: analysisSchema,
  })
  .strict()
  .superRefine((report, refinement) => {
    const asOf = Date.parse(report.analysis.asOf)
    const observations: ReadonlyArray<
      readonly [readonly (string | number)[], string]
    > = [
      [
        ["analysis", "accountChecks", "observedAt"],
        report.analysis.accountChecks.observedAt,
      ],
      [
        ["analysis", "marketRegime", "observedAt"],
        report.analysis.marketRegime.observedAt,
      ],
      ...(report.analysis.candidateEvaluation === undefined
        ? []
        : [[
            ["analysis", "candidateEvaluation", "observedAt"],
            report.analysis.candidateEvaluation.observedAt,
          ] as const]),
      ...report.analysis.externalContext.map((source, index) => [
        ["analysis", "externalContext", index, "retrievedAt"] as const,
        source.retrievedAt,
      ] as const),
      ...(report.result.outcome !== "PROPOSE_TRADE"
        ? report.result.evidence.flatMap((claim, index) =>
            claim.kind === "SOURCED_FACT"
              ? [[
                  ["result", "evidence", index, "observedAt"] as const,
                  claim.observedAt,
                ] as const]
              : [],
          )
        : []),
    ]
    for (const [path, observedAt] of observations) {
      if (Date.parse(observedAt) > asOf) {
        refinement.addIssue({
          code: "custom",
          path: [...path],
          message: "Retained analysis cannot contain future observations",
        })
      }
    }

    const requiresExa =
      report.result.outcome !== "NO_ACTION" ||
      report.result.reasonCodes.some(
        (reason) => !EXA_EXEMPT_NO_ACTION_REASONS.has(reason),
      )
    if (
      requiresExa &&
      !report.analysis.externalContext.some(({ provider }) => provider === "EXA")
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "externalContext"],
        message: "Substantive research requires current Exa evidence",
      })
    }

    if (report.result.outcome !== "PROPOSE_TRADE") return
    const accountChecks = report.analysis.accountChecks
    if (accountChecks.accountStatus !== "ACTIVE") {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "accountChecks", "accountStatus"],
        message: "A proposal requires an active account",
      })
    }
    if (!accountChecks.optionsTradingApproved) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "accountChecks", "optionsTradingApproved"],
        message: "A proposal requires options trading approval",
      })
    }
    if (accountChecks.conflictingStrategyExposure) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "accountChecks", "conflictingStrategyExposure"],
        message: "A proposal cannot retain conflicting strategy exposure",
      })
    }
    if (report.analysis.marketRegime.temporalClass !== "LIVE") {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "marketRegime", "temporalClass"],
        message: "A proposal requires a live market regime",
      })
    }
    if (report.analysis.marketRegime.dailySessionCount !== 50) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "marketRegime", "dailySessionCount"],
        message: "A proposal requires exactly 50 completed daily sessions",
      })
    }
    if (report.analysis.marketRegime.intradayBarCount === 0) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "marketRegime", "intradayBarCount"],
        message: "A proposal requires completed intraday bars",
      })
    }
    if (report.analysis.symbolIndicators === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "symbolIndicators"],
        message: "A proposal requires comparison indicators for every underlying",
      })
    }
    for (const metric of [
      "dailyClose",
      "sma20",
      "sma50",
      "sessionVwap",
      "spotMidpoint",
    ] as const) {
      if (report.analysis.marketRegime[metric] === undefined) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "marketRegime", metric],
          message: "A proposal must retain every directional signal metric",
        })
      }
    }
    if (report.analysis.marketRegime.signal !== report.result.direction) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "marketRegime", "signal"],
        message: "The retained market signal must match the proposal direction",
      })
    }
    const { dailyClose, sma20, sma50, sessionVwap, spotMidpoint } =
      report.analysis.marketRegime
    if (
      dailyClose !== undefined &&
      sma20 !== undefined &&
      sma50 !== undefined &&
      sessionVwap !== undefined &&
      spotMidpoint !== undefined
    ) {
      const metricsSupportDirection =
        report.result.direction === "BULLISH"
          ? dailyClose > sma20 &&
            sma20 > sma50 &&
            spotMidpoint > sessionVwap
          : dailyClose < sma20 &&
            sma20 < sma50 &&
            spotMidpoint < sessionVwap
      if (!metricsSupportDirection) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "marketRegime", "signal"],
          message: "The retained metrics must support the proposal direction",
        })
      }
    }
    const evaluation = report.analysis.candidateEvaluation
    if (evaluation === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "candidateEvaluation"],
        message: "A proposal requires retained candidate diagnostics",
      })
      return
    }
    if (evaluation.observedAt !== report.analysis.marketRegime.observedAt) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "candidateEvaluation", "observedAt"],
        message: "Candidate diagnostics must share the market snapshot instant",
      })
    }
    if (evaluation.dte < 14 || evaluation.dte > 30) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "candidateEvaluation", "dte"],
        message: "A proposal requires 14 to 30 calendar days to expiration",
      })
    }
    const expectedSymbols = new Map([
      ["LONG", report.result.candidate.longLeg.contractSymbol],
      ["SHORT", report.result.candidate.shortLeg.contractSymbol],
    ])
    evaluation.legs.forEach((leg, index) => {
      if (expectedSymbols.get(leg.role) !== leg.contractSymbol) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "candidateEvaluation", "legs", index, "contractSymbol"],
          message: "Candidate diagnostics must match the proposed legs",
        })
      }
      const absoluteDelta = Math.abs(leg.delta)
      const deltaEligible =
        leg.role === "LONG"
          ? absoluteDelta >= 0.45 && absoluteDelta <= 0.6
          : absoluteDelta >= 0.2 && absoluteDelta <= 0.35
      if (!deltaEligible) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "candidateEvaluation", "legs", index, "delta"],
          message: "Candidate delta is outside the strategy prefilter",
        })
      }
      if (leg.volume < 100) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "candidateEvaluation", "legs", index, "volume"],
          message: "Candidate volume is below the strategy prefilter",
        })
      }
      if (leg.openInterest < 500) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "candidateEvaluation", "legs", index, "openInterest"],
          message: "Candidate open interest is below the strategy prefilter",
        })
      }
    })
  })

export type ResearchReportV3 = Readonly<z.infer<typeof researchReportV3Schema>>
export type ResearchReportResultV2 = ResearchDecisionV2 | PreliminaryResearchV2
