import { z } from "zod"

import {
  alpacaOptionSymbolSchema,
  optionUnderlyingV1Schema,
} from "../shared/alpaca-option-identity.js"
import {
  RESEARCH_SHORTLIST_LIMIT,
  optionUniverseSnapshotV2Schema,
} from "./option-universe-v2.js"
import {
  TRADE_PROPOSAL_LIMIT,
  researchDecisionV3Schema,
} from "./research-decision-v3.js"
import {
  deriveVerticalSpreadGreeksV1,
  verticalSpreadGreeksV1Schema,
} from "../shared/vertical-spread-greeks.js"

export const RESEARCH_REPORT_VERSION = "6.0.0" as const

const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const boundedText = z.string().trim().min(1).max(2_000)
const boundedIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const positiveMetric = z.number().finite().positive()
const signedMetric = z.number().finite().min(-10).max(10)
const ratioMetric = z.number().finite().nonnegative().max(10)
const normalizedMetric = z.number().finite().min(0).max(1)
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
    /** Identifies the candidate-specific setup; broad-market context is separate. */
    underlying: optionUnderlyingV1Schema.optional(),
    dailyClose: positiveMetric.optional(),
    sma20: positiveMetric.optional(),
    sma50: positiveMetric.optional(),
    sessionVwap: positiveMetric.optional(),
    spotMidpoint: positiveMetric.optional(),
    gapPercent: returnMetric.optional(),
    distanceFromSma20: signedMetric.optional(),
    distanceFromSessionVwap: signedMetric.optional(),
    intradayRealizedVolatility: positiveMetric.optional(),
    dailySessionCount: z.number().int().nonnegative().max(250),
    intradayBarCount: z.number().int().nonnegative().max(1_000),
  })
  .strict()

const symbolIndicatorSchema = z
  .object({
    underlying: optionUnderlyingV1Schema,
    throughSessionDate: z.iso.date(),
    return5d: returnMetric,
    return20d: returnMetric,
    relativeStrengthRank20d: z.number().int().min(1).max(RESEARCH_SHORTLIST_LIMIT),
    realizedVolatility20: positiveMetric,
    completedSessionVolumeRatio20: positiveMetric,
    atrPercent20: ratioMetric.optional(),
    ewmaRealizedVolatility20: positiveMetric.optional(),
    sma20Slope5d: signedMetric.optional(),
    completedSessionDollarVolumeRatio20: positiveMetric.optional(),
    rangePosition20: normalizedMetric.optional(),
  })
  .strict()

const symbolIndicatorsSchema = z
  .array(symbolIndicatorSchema)
  .max(RESEARCH_SHORTLIST_LIMIT)
  .superRefine((indicators, refinement) => {
    const underlyings = new Set(indicators.map(({ underlying }) => underlying))
    const ranks = new Set(indicators.map(({ relativeStrengthRank20d }) => relativeStrengthRank20d))
    const throughDates = new Set(indicators.map(({ throughSessionDate }) => throughSessionDate))
    if (underlyings.size !== indicators.length) {
      refinement.addIssue({
        code: "custom",
        path: [],
        message: "Symbol indicators must cover every shortlisted underlying exactly once",
      })
    }
    if (
      ranks.size !== indicators.length ||
      indicators.some(({ relativeStrengthRank20d }) =>
        relativeStrengthRank20d > indicators.length
      )
    ) {
      refinement.addIssue({
        code: "custom",
        path: [],
        message: "Relative-strength ranks must be unique",
      })
    }
    if (indicators.length > 0 && throughDates.size !== 1) {
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
    contractSymbol: alpacaOptionSymbolSchema,
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
    underlying: optionUnderlyingV1Schema,
    expiration: z.iso.date(),
    dte: z.number().int().nonnegative().max(365),
    legs: z.array(candidateLegAnalysisSchema).length(2),
    spreadGreeks: verticalSpreadGreeksV1Schema.optional(),
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
    const longLeg = evaluation.legs.find(({ role }) => role === "LONG")
    const shortLeg = evaluation.legs.find(({ role }) => role === "SHORT")
    if (
      evaluation.spreadGreeks !== undefined &&
      longLeg !== undefined &&
      shortLeg !== undefined
    ) {
      const expected = deriveVerticalSpreadGreeksV1(longLeg, shortLeg)
      if (
        expected === undefined ||
        JSON.stringify(evaluation.spreadGreeks) !== JSON.stringify(expected)
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["spreadGreeks"],
          message: "Spread Greeks must equal long-leg Greeks minus short-leg Greeks",
        })
      }
    }
  })

const symbolEvaluationSchema = z
  .object({
    underlying: optionUnderlyingV1Schema,
    disposition: z.enum(["REJECT", "WATCH", "PROPOSE"]),
    direction: z.enum(["BULLISH", "BEARISH", "NEUTRAL"]),
    summary: boundedText,
  })
  .strict()
  .superRefine((evaluation, refinement) => {
    if (
      evaluation.disposition === "PROPOSE" &&
      evaluation.direction === "NEUTRAL"
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["direction"],
        message: "A proposed symbol evaluation requires a direction",
      })
    }
  })

const broadMarketContextSchema = z
  .object({
    verification: z.literal("AGENT_REPORTED"),
    temporalClass: z.enum(["LIVE", "DELAYED", "PRIOR_CLOSE"]),
    observedAt: timestamp,
    benchmark: optionUnderlyingV1Schema,
    signal: z.enum(["BULLISH", "BEARISH", "MIXED", "UNAVAILABLE"]),
    dailyClose: positiveMetric.optional(),
    sma20: positiveMetric.optional(),
    sma50: positiveMetric.optional(),
    realizedVolatility20: positiveMetric.optional(),
    breadthSummary: boundedText.optional(),
  })
  .strict()

const eventRiskSchema = z
  .object({
    verification: z.literal("AGENT_REPORTED"),
    status: z.enum([
      "CLEAR",
      "EARNINGS",
      "DIVIDEND",
      "MACRO",
      "MULTIPLE",
      "UNKNOWN",
    ]),
    eventBeforeExpiration: z.boolean().optional(),
    earningsDate: z.iso.date().optional(),
    exDividendDate: z.iso.date().optional(),
    macroEvents: z.array(z.string().trim().min(1).max(160)).max(6),
  })
  .strict()
  .superRefine((eventRisk, refinement) => {
    const expectedBeforeExpiration = eventRisk.status === "UNKNOWN"
      ? undefined
      : eventRisk.status !== "CLEAR"
    if (eventRisk.eventBeforeExpiration !== expectedBeforeExpiration) {
      refinement.addIssue({
        code: "custom",
        path: ["eventBeforeExpiration"],
        message: "Event status and before-expiration classification must agree",
      })
    }
    if (eventRisk.status === "EARNINGS" && eventRisk.earningsDate === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["earningsDate"],
        message: "Earnings event risk requires the earnings date",
      })
    }
    if (eventRisk.status === "DIVIDEND" && eventRisk.exDividendDate === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["exDividendDate"],
        message: "Dividend event risk requires the ex-dividend date",
      })
    }
    if (eventRisk.status === "MACRO" && eventRisk.macroEvents.length === 0) {
      refinement.addIssue({
        code: "custom",
        path: ["macroEvents"],
        message: "Macro event risk requires at least one identified event",
      })
    }
  })

const optionSurfaceSchema = z
  .object({
    verification: z.literal("AGENT_REPORTED"),
    observedAt: timestamp,
    underlying: optionUnderlyingV1Schema,
    expiration: z.iso.date(),
    feed: z.enum(["OPRA", "INDICATIVE", "UNKNOWN"]),
    atmImpliedVolatility: positiveMetric,
    forecastRealizedVolatility: positiveMetric,
    ivRvVarianceSpread: signedMetric,
    impliedMovePercent: ratioMetric,
    termStructureSlope: signedMetric.optional(),
    putCallSkew25Delta: signedMetric.optional(),
    verticalLegIvDifference: signedMetric.optional(),
    smileCurvature: signedMetric.optional(),
    quoteCoverage: normalizedMetric,
    eventRisk: eventRiskSchema,
  })
  .strict()

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
    optionUniverse: optionUniverseSnapshotV2Schema.optional(),
    accountChecks: accountChecksSchema,
    broadMarketContext: broadMarketContextSchema.optional(),
    symbolEvaluations: z.array(symbolEvaluationSchema).max(RESEARCH_SHORTLIST_LIMIT),
    marketRegimes: z.array(marketRegimeSchema).max(TRADE_PROPOSAL_LIMIT),
    symbolIndicators: symbolIndicatorsSchema.optional(),
    optionSurfaces: z.array(optionSurfaceSchema).max(TRADE_PROPOSAL_LIMIT),
    candidateEvaluations: z
      .array(candidateEvaluationSchema)
      .max(TRADE_PROPOSAL_LIMIT),
    externalContext: z.array(externalContextSchema).max(8),
    supportingFactors: z.array(boundedText).max(12),
    contradictingFactors: z.array(boundedText).max(12),
    conflicts: z.array(boundedText).max(12),
  })
  .strict()

const EXA_EXEMPT_NO_ACTION_REASONS = new Set([
  "MARKET_WINDOW_INELIGIBLE",
  "ACCOUNT_STATE_INELIGIBLE",
  "POSITION_OR_RISK_LIMIT_ACTIVE",
  "INSUFFICIENT_UNDERLYING_DATA",
  "REQUIRED_ALPACA_DATA_INVALID",
  "REQUIRED_EXA_EVIDENCE_UNAVAILABLE",
  "CONTRACT_UNREPRESENTABLE",
])

export const researchReportV6Schema = z
  .object({
    reportVersion: z.literal(RESEARCH_REPORT_VERSION),
    result: researchDecisionV3Schema,
    analysis: analysisSchema,
  })
  .strict()
  .superRefine((report, refinement) => {
    const universe = report.analysis.optionUniverse
    if (universe !== undefined) {
      const allowed = new Set(
        universe.candidates.map(({ underlying }) => underlying),
      )
      const indicatorIndex = report.analysis.symbolIndicators?.findIndex(
        ({ underlying }) => !allowed.has(underlying),
      ) ?? -1
      if (indicatorIndex >= 0) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "symbolIndicators", indicatorIndex, "underlying"],
          message: "Symbol indicators must use the supplied option universe",
        })
      }
      if (report.analysis.symbolIndicators !== undefined) {
        const indicatorSymbols = new Set(
          report.analysis.symbolIndicators.map(({ underlying }) => underlying),
        )
        if (
          indicatorSymbols.size !== universe.candidates.length ||
          [...indicatorSymbols].some((underlying) => !allowed.has(underlying))
        ) {
          refinement.addIssue({
            code: "custom",
            path: ["analysis", "symbolIndicators"],
            message: "Symbol indicators must cover every shortlisted underlying exactly once",
          })
        }
      }
      const evaluationSymbols = new Set(
        report.analysis.symbolEvaluations.map(({ underlying }) => underlying),
      )
      if (
        evaluationSymbols.size !== universe.candidates.length ||
        [...evaluationSymbols].some((underlying) => !allowed.has(underlying))
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "symbolEvaluations"],
          message: "Symbol evaluations must cover every shortlisted underlying exactly once",
        })
      }
      if (report.result.outcome === "PROPOSE_TRADES") {
        report.result.proposals.forEach((proposal, index) => {
          if (!allowed.has(proposal.candidate.underlying)) {
            refinement.addIssue({
              code: "custom",
              path: ["result", "proposals", index, "candidate", "underlying"],
              message: "Every proposal must belong to the supplied option universe",
            })
          }
        })
      }
    }

    const asOf = Date.parse(report.analysis.asOf)
    const observations: ReadonlyArray<
      readonly [readonly (string | number)[], string]
    > = [
      [
        ["analysis", "accountChecks", "observedAt"],
        report.analysis.accountChecks.observedAt,
      ],
      ...report.analysis.marketRegimes.map((regime, index) => [
        ["analysis", "marketRegimes", index, "observedAt"] as const,
        regime.observedAt,
      ] as const),
      ...(report.analysis.broadMarketContext === undefined
        ? []
        : [[
            ["analysis", "broadMarketContext", "observedAt"],
            report.analysis.broadMarketContext.observedAt,
          ] as const]),
      ...report.analysis.optionSurfaces.map((surface, index) => [
        ["analysis", "optionSurfaces", index, "observedAt"] as const,
        surface.observedAt,
      ] as const),
      ...report.analysis.candidateEvaluations.map((evaluation, index) => [
        ["analysis", "candidateEvaluations", index, "observedAt"] as const,
        evaluation.observedAt,
      ] as const),
      ...report.analysis.externalContext.map((source, index) => [
        ["analysis", "externalContext", index, "retrievedAt"] as const,
        source.retrievedAt,
      ] as const),
      ...(report.result.outcome === "NO_ACTION"
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

    if (report.result.outcome !== "PROPOSE_TRADES") return
    const proposalUnderlyings = new Set(
      report.result.proposals.map(({ candidate }) => candidate.underlying),
    )
    const evaluatedAsProposals = new Set(
      report.analysis.symbolEvaluations
        .filter(({ disposition }) => disposition === "PROPOSE")
        .map(({ underlying }) => underlying),
    )
    if (
      evaluatedAsProposals.size !== proposalUnderlyings.size ||
      [...evaluatedAsProposals].some(
        (underlying) => !proposalUnderlyings.has(underlying),
      )
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "symbolEvaluations"],
        message: "PROPOSE symbol evaluations must match the portfolio proposals",
      })
    }
    for (const [field, values] of [
      ["marketRegimes", report.analysis.marketRegimes],
      ["optionSurfaces", report.analysis.optionSurfaces],
      ["candidateEvaluations", report.analysis.candidateEvaluations],
    ] as const) {
      const underlyings = new Set(
        values.map(({ underlying }) => underlying),
      )
      if (
        underlyings.size !== proposalUnderlyings.size ||
        [...underlyings].some(
          (underlying) =>
            underlying === undefined || !proposalUnderlyings.has(underlying),
        )
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", field],
          message: "Deep research must cover every proposed underlying exactly once",
        })
      }
    }
    if (universe === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "optionUniverse"],
        message: "A proposal requires the application-supplied option universe",
      })
    } else {
      universe.candidates.forEach((candidate, index) => {
        if (candidate.optionLiquidity === undefined) {
          refinement.addIssue({
            code: "custom",
            path: ["analysis", "optionUniverse", "candidates", index, "optionLiquidity"],
            message: "A proposal requires application-computed option liquidity for every shortlisted underlying",
          })
        }
      })
    }
    if (report.analysis.broadMarketContext === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "broadMarketContext"],
        message: "A proposal requires broad-market context separate from the candidate setup",
      })
    }
    for (const [proposalIndex, proposal] of report.result.proposals.entries()) {
      const proposedCandidate = proposal.candidate
      const regimeIndex = report.analysis.marketRegimes.findIndex(
        ({ underlying }) => underlying === proposedCandidate.underlying,
      )
      const marketRegime = report.analysis.marketRegimes[regimeIndex]
      const surfaceIndex = report.analysis.optionSurfaces.findIndex(
        ({ underlying }) => underlying === proposedCandidate.underlying,
      )
      const optionSurface = report.analysis.optionSurfaces[surfaceIndex]
      const evaluationIndex = report.analysis.candidateEvaluations.findIndex(
        ({ underlying }) => underlying === proposedCandidate.underlying,
      )
      const evaluation = report.analysis.candidateEvaluations[evaluationIndex]
      if (
        marketRegime === undefined ||
        optionSurface === undefined ||
        evaluation === undefined
      ) continue
    if (marketRegime.underlying === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "marketRegimes", regimeIndex, "underlying"],
        message: "A proposal must identify the underlying for its candidate setup",
      })
    }
    if (
      marketRegime.underlying !== undefined &&
      marketRegime.underlying !== proposedCandidate.underlying
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "marketRegimes", regimeIndex, "underlying"],
        message: "The candidate setup must identify the proposed underlying",
      })
    }
    if (
      optionSurface !== undefined &&
      optionSurface.underlying !== proposedCandidate.underlying
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "optionSurfaces", surfaceIndex, "underlying"],
        message: "Option-surface evidence must identify the proposed underlying",
      })
    }
    if (
      optionSurface !== undefined &&
      optionSurface.expiration !== proposedCandidate.expiration
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "optionSurfaces", surfaceIndex, "expiration"],
        message: "Option-surface evidence must match the proposed expiration",
      })
    }
    if (optionSurface !== undefined) {
      const expectedVarianceSpread =
        optionSurface.atmImpliedVolatility ** 2 -
        optionSurface.forecastRealizedVolatility ** 2
      if (
        Math.abs(optionSurface.ivRvVarianceSpread - expectedVarianceSpread) >
          1e-9
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "optionSurfaces", surfaceIndex, "ivRvVarianceSpread"],
          message: "IV/RV variance spread must equal squared ATM IV minus squared forecast volatility",
        })
      }
      const selectedIndicator = report.analysis.symbolIndicators?.find(
        ({ underlying }) => underlying === proposedCandidate.underlying,
      )
      if (
        selectedIndicator?.ewmaRealizedVolatility20 !== undefined &&
        Math.abs(
          optionSurface.forecastRealizedVolatility -
            selectedIndicator.ewmaRealizedVolatility20,
        ) > 1e-9
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "optionSurfaces", surfaceIndex, "forecastRealizedVolatility"],
          message: "Surface forecast volatility must use the selected underlying EWMA estimate",
        })
      }
    }
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
    if (marketRegime.temporalClass !== "LIVE") {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "marketRegimes", regimeIndex, "temporalClass"],
        message: "A proposal requires a live market regime",
      })
    }
    if (marketRegime.dailySessionCount !== 50) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "marketRegimes", regimeIndex, "dailySessionCount"],
        message: "A proposal requires exactly 50 completed daily sessions",
      })
    }
    if (marketRegime.intradayBarCount < 2) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "marketRegimes", regimeIndex, "intradayBarCount"],
        message: "A proposal requires at least two completed intraday bars",
      })
    }
    if (report.analysis.symbolIndicators === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "symbolIndicators"],
        message: "A proposal requires comparison indicators for every underlying",
      })
    }
    report.analysis.symbolIndicators?.forEach((indicator, index) => {
      for (const metric of [
        "atrPercent20",
        "ewmaRealizedVolatility20",
        "sma20Slope5d",
        "completedSessionDollarVolumeRatio20",
        "rangePosition20",
      ] as const) {
        if (indicator[metric] === undefined) {
          refinement.addIssue({
            code: "custom",
            path: ["analysis", "symbolIndicators", index, metric],
            message: "A proposal requires every enhanced underlying indicator",
          })
        }
      }
    })
    for (const metric of [
      "dailyClose",
      "sma20",
      "sma50",
      "sessionVwap",
      "spotMidpoint",
      "gapPercent",
      "distanceFromSma20",
      "distanceFromSessionVwap",
      "intradayRealizedVolatility",
    ] as const) {
      if (marketRegime[metric] === undefined) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "marketRegimes", regimeIndex, metric],
          message: "A proposal must retain every directional signal metric",
        })
      }
    }
    if (optionSurface === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "optionSurfaces"],
        message: "A proposal requires target-expiration option-surface evidence",
      })
    } else {
      if (optionSurface.observedAt !== marketRegime.observedAt) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "optionSurfaces", surfaceIndex, "observedAt"],
          message: "Option-surface evidence must share the live market snapshot instant",
        })
      }
      if (optionSurface.feed === "UNKNOWN") {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "optionSurfaces", surfaceIndex, "feed"],
          message: "A proposal requires an identified option quote feed",
        })
      }
      for (const metric of [
        "termStructureSlope",
        "putCallSkew25Delta",
        "verticalLegIvDifference",
        "smileCurvature",
      ] as const) {
        if (optionSurface[metric] === undefined) {
          refinement.addIssue({
            code: "custom",
            path: ["analysis", "optionSurfaces", surfaceIndex, metric],
            message: "A proposal requires every option-surface dimension",
          })
        }
      }
      if (
        optionSurface.eventRisk.status === "UNKNOWN" ||
        optionSurface.eventRisk.eventBeforeExpiration === undefined
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "optionSurfaces", surfaceIndex, "eventRisk"],
          message: "A proposal requires classified event risk through expiration",
        })
      }
    }
    if (marketRegime.signal !== proposal.direction) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "marketRegimes", regimeIndex, "signal"],
        message: "The retained market signal must match the proposal direction",
      })
    }
    const { dailyClose, sma20, sma50, sessionVwap, spotMidpoint } =
      marketRegime
    if (
      dailyClose !== undefined &&
      sma20 !== undefined &&
      sma50 !== undefined &&
      sessionVwap !== undefined &&
      spotMidpoint !== undefined
    ) {
      const metricsSupportDirection =
        proposal.direction === "BULLISH"
          ? dailyClose > sma20 &&
            sma20 > sma50 &&
            spotMidpoint > sessionVwap
          : dailyClose < sma20 &&
            sma20 < sma50 &&
            spotMidpoint < sessionVwap
      if (!metricsSupportDirection) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "marketRegimes", regimeIndex, "signal"],
          message: "The retained metrics must support the proposal direction",
        })
      }
    }
    if (evaluation === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "candidateEvaluations"],
        message: "A proposal requires retained candidate diagnostics",
      })
      return
    }
    if (
      evaluation.underlying !== proposedCandidate.underlying ||
      evaluation.expiration !== proposedCandidate.expiration
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "candidateEvaluations", evaluationIndex],
        message: "Candidate diagnostics must match the proposed underlying and expiration",
      })
    }
    if (evaluation.spreadGreeks === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "candidateEvaluations", evaluationIndex, "spreadGreeks"],
        message: "A proposal requires retained long-minus-short spread Greeks",
      })
    } else {
      const netDeltaEligible = proposal.direction === "BULLISH"
        ? evaluation.spreadGreeks.netDelta >= 0.1 &&
          evaluation.spreadGreeks.netDelta <= 0.4
        : evaluation.spreadGreeks.netDelta >= -0.4 &&
          evaluation.spreadGreeks.netDelta <= -0.1
      if (!netDeltaEligible) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "candidateEvaluations", evaluationIndex, "spreadGreeks", "netDelta"],
          message: "Retained spread net delta is outside the directional strategy range",
        })
      }
    }
    if (evaluation.observedAt !== marketRegime.observedAt) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "candidateEvaluations", evaluationIndex, "observedAt"],
        message: "Candidate diagnostics must share the market snapshot instant",
      })
    }
    if (evaluation.dte < 14 || evaluation.dte > 30) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "candidateEvaluations", evaluationIndex, "dte"],
        message: "A proposal requires 14 to 30 calendar days to expiration",
      })
    }
    const expectedSymbols = new Map([
      ["LONG", proposedCandidate.longLeg.contractSymbol],
      ["SHORT", proposedCandidate.shortLeg.contractSymbol],
    ])
    evaluation.legs.forEach((leg, index) => {
      if (expectedSymbols.get(leg.role) !== leg.contractSymbol) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "candidateEvaluations", evaluationIndex, "legs", index, "contractSymbol"],
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
          path: ["analysis", "candidateEvaluations", evaluationIndex, "legs", index, "delta"],
          message: "Candidate delta is outside the strategy prefilter",
        })
      }
      if (leg.volume < 100) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "candidateEvaluations", evaluationIndex, "legs", index, "volume"],
          message: "Candidate volume is below the strategy prefilter",
        })
      }
      if (leg.openInterest < 500) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "candidateEvaluations", evaluationIndex, "legs", index, "openInterest"],
          message: "Candidate open interest is below the strategy prefilter",
        })
      }
    })
    if (optionSurface?.verticalLegIvDifference !== undefined) {
      const longLeg = evaluation.legs.find(({ role }) => role === "LONG")
      const shortLeg = evaluation.legs.find(({ role }) => role === "SHORT")
      if (
        longLeg !== undefined &&
        shortLeg !== undefined &&
        Math.abs(
          optionSurface.verticalLegIvDifference -
            (longLeg.impliedVolatility - shortLeg.impliedVolatility),
        ) > 1e-9
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "optionSurfaces", surfaceIndex, "verticalLegIvDifference"],
          message: "Vertical-leg IV difference must equal long-leg IV minus short-leg IV",
        })
      }
    }
    }
  })

export type ResearchReportV6 = Readonly<z.infer<typeof researchReportV6Schema>>
