import { z } from "zod"

import { alpacaOptionEntryLegV2Schema } from "../options/alpaca-capabilities.js"
import {
  optionUnderlyingV1Schema,
  parseAlpacaOptionSymbol,
} from "../shared/alpaca-option-identity.js"
import { deriveOptionLegAggregateGreeksV1 } from "../shared/option-leg-aggregate-greeks.js"
import { researchDecisionV4Schema } from "./research-decision-v4.js"
import { researchAnalysisV6Schema } from "./research-report-v6.js"

export const RESEARCH_REPORT_V7_VERSION = "7.0.0" as const

const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const count = z.number().int().nonnegative().safe()
const finite = z.number().finite()
const EXA_EXEMPT_NO_ACTION_REASONS = new Set([
  "MARKET_WINDOW_INELIGIBLE",
  "ACCOUNT_STATE_INELIGIBLE",
  "POSITION_OR_RISK_LIMIT_ACTIVE",
  "INSUFFICIENT_UNDERLYING_DATA",
  "REQUIRED_ALPACA_DATA_INVALID",
  "REQUIRED_EXA_EVIDENCE_UNAVAILABLE",
  "CONTRACT_UNREPRESENTABLE",
])

const candidateLegAnalysisV1Schema = alpacaOptionEntryLegV2Schema.extend({
  delta: finite,
  impliedVolatility: finite,
  gamma: finite,
  theta: finite,
  vega: finite,
  volume: count,
  openInterest: count,
  openInterestDate: z.iso.date(),
}).strict()

const aggregateGreeksV1Schema = z
  .object({
    calculation: z.literal("POSITION_WEIGHTED_SUM"),
    netDelta: finite,
    netGamma: finite,
    netTheta: finite,
    netVega: finite,
  })
  .strict()

export const candidateEvaluationV7Schema = z
  .object({
    verification: z.literal("AGENT_REPORTED"),
    observedAt: timestamp,
    underlying: optionUnderlyingV1Schema,
    legs: z.array(candidateLegAnalysisV1Schema).min(1).max(4),
    aggregateGreeks: aggregateGreeksV1Schema.optional(),
  })
  .strict()
  .superRefine((evaluation, refinement) => {
    if (evaluation.aggregateGreeks === undefined) return
    const expected = deriveOptionLegAggregateGreeksV1(evaluation.legs)
    if (
      expected === undefined ||
      JSON.stringify(expected) !== JSON.stringify(evaluation.aggregateGreeks)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["aggregateGreeks"],
        message: "Aggregate Greeks must use signed position-weighted quantities",
      })
    }
  })

export const researchAnalysisV7Schema = researchAnalysisV6Schema
  .omit({ candidateEvaluations: true })
  .extend({
    candidateEvaluations: z.array(candidateEvaluationV7Schema).max(3),
  })
  .strict()

export const researchReportV7Schema = z
  .object({
    reportVersion: z.literal(RESEARCH_REPORT_V7_VERSION),
    result: researchDecisionV4Schema,
    analysis: researchAnalysisV7Schema,
  })
  .strict()
  .superRefine((report, refinement) => {
    const asOf = Date.parse(report.analysis.asOf)
    const universe = report.analysis.optionUniverse
    if (universe !== undefined) {
      const allowed = new Set(universe.candidates.map(({ underlying }) => underlying))
      const evaluations = report.analysis.symbolEvaluations.map(
        ({ underlying }) => underlying,
      )
      if (
        new Set(evaluations).size !== universe.candidates.length ||
        evaluations.some((underlying) => !allowed.has(underlying))
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "symbolEvaluations"],
          message: "Symbol evaluations must cover the supplied universe exactly once",
        })
      }
      if (report.analysis.symbolIndicators !== undefined) {
        const indicators = report.analysis.symbolIndicators.map(
          ({ underlying }) => underlying,
        )
        if (
          new Set(indicators).size !== universe.candidates.length ||
          indicators.some((underlying) => !allowed.has(underlying))
        ) {
          refinement.addIssue({
            code: "custom",
            path: ["analysis", "symbolIndicators"],
            message: "Symbol indicators must cover the supplied universe exactly once",
          })
        }
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

    const observations: ReadonlyArray<Readonly<{
      path: readonly (string | number)[]
      observedAt: string
    }>> = [
      {
        path: ["analysis", "accountChecks", "observedAt"],
        observedAt: report.analysis.accountChecks.observedAt,
      },
      ...report.analysis.marketRegimes.map((regime, index) => ({
        path: ["analysis", "marketRegimes", index, "observedAt"],
        observedAt: regime.observedAt,
      })),
      ...(report.analysis.broadMarketContext === undefined
        ? []
        : [{
            path: ["analysis", "broadMarketContext", "observedAt"],
            observedAt: report.analysis.broadMarketContext.observedAt,
          }]),
      ...report.analysis.optionSurfaces.map((surface, index) => ({
        path: ["analysis", "optionSurfaces", index, "observedAt"],
        observedAt: surface.observedAt,
      })),
      ...report.analysis.candidateEvaluations.map((evaluation, index) => ({
        path: ["analysis", "candidateEvaluations", index, "observedAt"],
        observedAt: evaluation.observedAt,
      })),
      ...report.analysis.externalContext.map((source, index) => ({
        path: ["analysis", "externalContext", index, "retrievedAt"],
        observedAt: source.retrievedAt,
      })),
      ...(report.result.outcome === "NO_ACTION"
        ? report.result.evidence.flatMap((claim, index) =>
            claim.kind === "SOURCED_FACT"
              ? [{
                  path: ["result", "evidence", index, "observedAt"],
                  observedAt: claim.observedAt,
                }]
              : []
          )
        : []),
    ]
    for (const observation of observations) {
      if (Date.parse(observation.observedAt) > asOf) {
        refinement.addIssue({
          code: "custom",
          path: [...observation.path],
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
    const proposed = new Set(
      report.result.proposals.map(({ candidate }) => candidate.underlying),
    )
    const evaluatedAsProposals = report.analysis.symbolEvaluations
      .filter(({ disposition }) => disposition === "PROPOSE")
      .map(({ underlying }) => underlying)
    if (
      new Set(evaluatedAsProposals).size !== proposed.size ||
      evaluatedAsProposals.some((underlying) => !proposed.has(underlying))
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "symbolEvaluations"],
        message: "PROPOSE symbol evaluations must match the portfolio proposals",
      })
    }

    const requireExactCoverage = (
      field: "marketRegimes" | "optionSurfaces" | "candidateEvaluations",
      underlyings: readonly (string | undefined)[],
    ) => {
      if (
        new Set(underlyings).size !== proposed.size ||
        underlyings.some(
          (underlying) => underlying === undefined || !proposed.has(underlying),
        )
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", field],
          message: "Deep research must cover every proposed underlying exactly once",
        })
      }
    }
    requireExactCoverage(
      "marketRegimes",
      report.analysis.marketRegimes.map(({ underlying }) => underlying),
    )
    requireExactCoverage(
      "optionSurfaces",
      report.analysis.optionSurfaces.map(({ underlying }) => underlying),
    )
    requireExactCoverage(
      "candidateEvaluations",
      report.analysis.candidateEvaluations.map(({ underlying }) => underlying),
    )

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

    if (report.analysis.symbolIndicators === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "symbolIndicators"],
        message: "A proposal requires comparison indicators for every underlying",
      })
    }
    report.analysis.symbolIndicators?.forEach((indicator, index) => {
      // Only the metrics that gate a decision are required. The rest stayed
      // mandatory long after they stopped deciding anything, and demanding
      // them cost model reasoning on every cycle without changing an outcome.
      for (const metric of [
        "ewmaRealizedVolatility20",
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

    report.result.proposals.forEach((proposal) => {
      const underlying = proposal.candidate.underlying
      const regimeIndex = report.analysis.marketRegimes.findIndex(
        (regime) => regime.underlying === underlying,
      )
      const surfaceIndex = report.analysis.optionSurfaces.findIndex(
        (surface) => surface.underlying === underlying,
      )
      const evaluationIndex = report.analysis.candidateEvaluations.findIndex(
        (evaluation) => evaluation.underlying === underlying,
      )
      const regime = report.analysis.marketRegimes[regimeIndex]
      const surface = report.analysis.optionSurfaces[surfaceIndex]
      const evaluation = report.analysis.candidateEvaluations[evaluationIndex]
      if (regime === undefined || surface === undefined || evaluation === undefined) {
        return
      }

      if (regime.temporalClass !== "LIVE") {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "marketRegimes", regimeIndex, "temporalClass"],
          message: "A proposal requires a live market regime",
        })
      }
      if (regime.dailySessionCount !== 50) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "marketRegimes", regimeIndex, "dailySessionCount"],
          message: "A proposal requires exactly 50 completed daily sessions",
        })
      }
      if (regime.intradayBarCount < 2) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "marketRegimes", regimeIndex, "intradayBarCount"],
          message: "A proposal requires at least two completed intraday bars",
        })
      }
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
        if (regime[metric] === undefined) {
          refinement.addIssue({
            code: "custom",
            path: ["analysis", "marketRegimes", regimeIndex, metric],
            message: "A proposal must retain every directional signal metric",
          })
        }
      }
      if (
        (proposal.direction === "BULLISH" || proposal.direction === "BEARISH") &&
        regime.signal !== proposal.direction
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "marketRegimes", regimeIndex, "signal"],
          message: "The retained market signal must match the proposal direction",
        })
      }
      const { dailyClose, sma20, sma50, sessionVwap, spotMidpoint } = regime
      if (
        (proposal.direction === "BULLISH" || proposal.direction === "BEARISH") &&
        dailyClose !== undefined &&
        sma20 !== undefined &&
        sma50 !== undefined &&
        sessionVwap !== undefined &&
        spotMidpoint !== undefined
      ) {
        const supportsDirection = proposal.direction === "BULLISH"
          ? dailyClose > sma20 && sma20 > sma50 && spotMidpoint > sessionVwap
          : dailyClose < sma20 && sma20 < sma50 && spotMidpoint < sessionVwap
        if (!supportsDirection) {
          refinement.addIssue({
            code: "custom",
            path: ["analysis", "marketRegimes", regimeIndex, "signal"],
            message: "The retained metrics must support the proposal direction",
          })
        }
      }

      if (surface.observedAt !== regime.observedAt) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "optionSurfaces", surfaceIndex, "observedAt"],
          message: "Option-surface evidence must share the live market snapshot instant",
        })
      }
      if (surface.feed === "UNKNOWN") {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "optionSurfaces", surfaceIndex, "feed"],
          message: "A proposal requires an identified option quote feed",
        })
      }
      // `ivRvVarianceSpread` gates the structure choice and is cross-checked
      // below; the remaining surface dimensions are retained when observed but
      // no longer required, for the same reason as the indicators above.
      if (surface.verticalLegIvDifference === undefined) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "optionSurfaces", surfaceIndex, "verticalLegIvDifference"],
          message: "A proposal requires the vertical leg IV difference",
        })
      }
      if (
        surface.eventRisk.status === "UNKNOWN" ||
        surface.eventRisk.eventBeforeExpiration === undefined
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "optionSurfaces", surfaceIndex, "eventRisk"],
          message: "A proposal requires classified event risk through expiration",
        })
      }
      const expectedVarianceSpread =
        surface.atmImpliedVolatility ** 2 -
        surface.forecastRealizedVolatility ** 2
      if (Math.abs(surface.ivRvVarianceSpread - expectedVarianceSpread) > 1e-9) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "optionSurfaces", surfaceIndex, "ivRvVarianceSpread"],
          message: "IV/RV variance spread must equal squared ATM IV minus squared forecast volatility",
        })
      }
      const selectedIndicator = report.analysis.symbolIndicators?.find(
        (indicator) => indicator.underlying === underlying,
      )
      if (
        selectedIndicator?.ewmaRealizedVolatility20 !== undefined &&
        Math.abs(
          surface.forecastRealizedVolatility -
            selectedIndicator.ewmaRealizedVolatility20,
        ) > 1e-9
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "optionSurfaces", surfaceIndex, "forecastRealizedVolatility"],
          message: "Surface forecast volatility must use the selected underlying EWMA estimate",
        })
      }
      const candidateExpirations = new Set(
        proposal.candidate.legs.flatMap(({ contractSymbol }) => {
          const parsed = parseAlpacaOptionSymbol(contractSymbol)
          return parsed.success ? [parsed.identity.expiration] : []
        }),
      )
      if (!candidateExpirations.has(surface.expiration)) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "optionSurfaces", surfaceIndex, "expiration"],
          message: "Option-surface evidence must match a proposed expiration",
        })
      }

      if (evaluation.observedAt !== regime.observedAt) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "candidateEvaluations", evaluationIndex, "observedAt"],
          message: "Candidate diagnostics must share the market snapshot instant",
        })
      }
      if (evaluation.aggregateGreeks === undefined) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "candidateEvaluations", evaluationIndex, "aggregateGreeks"],
          message: "A proposal requires retained position-weighted aggregate Greeks",
        })
      } else if (
        (proposal.direction === "BULLISH" &&
          (evaluation.aggregateGreeks.netDelta < 0.1 ||
            evaluation.aggregateGreeks.netDelta > 0.7)) ||
        (proposal.direction === "BEARISH" &&
          (evaluation.aggregateGreeks.netDelta < -0.7 ||
            evaluation.aggregateGreeks.netDelta > -0.1))
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "candidateEvaluations", evaluationIndex, "aggregateGreeks", "netDelta"],
          message: "Retained aggregate net delta is outside the directional strategy range",
        })
      }
      evaluation.legs.forEach((leg, legIndex) => {
        const identity = parseAlpacaOptionSymbol(leg.contractSymbol)
        const sessionDate = universe?.sessionDate
        if (identity.success && sessionDate !== undefined) {
          const dte = (
            Date.parse(`${identity.identity.expiration}T00:00:00.000Z`) -
            Date.parse(`${sessionDate}T00:00:00.000Z`)
          ) / 86_400_000
          if (dte < 14 || dte > 30) {
            refinement.addIssue({
              code: "custom",
              path: ["analysis", "candidateEvaluations", evaluationIndex, "legs", legIndex, "contractSymbol"],
              message: "A proposal requires 14 to 30 calendar days to expiration",
            })
          }
        }
        if (leg.volume < 100) {
          refinement.addIssue({
            code: "custom",
            path: ["analysis", "candidateEvaluations", evaluationIndex, "legs", legIndex, "volume"],
            message: "Candidate volume is below the strategy prefilter",
          })
        }
        if (leg.openInterest < 500) {
          refinement.addIssue({
            code: "custom",
            path: ["analysis", "candidateEvaluations", evaluationIndex, "legs", legIndex, "openInterest"],
            message: "Candidate open interest is below the strategy prefilter",
          })
        }
      })

      if (surface.verticalLegIvDifference !== undefined) {
        const bought = evaluation.legs.filter(
          ({ positionIntent }) => positionIntent === "BUY_TO_OPEN",
        )
        const sold = evaluation.legs.filter(
          ({ positionIntent }) => positionIntent === "SELL_TO_OPEN",
        )
        const averageIv = (legs: typeof evaluation.legs) =>
          legs.reduce((sum, leg) => sum + leg.impliedVolatility, 0) / legs.length
        const expectedDifference = bought.length > 0 && sold.length > 0
          ? averageIv(bought) - averageIv(sold)
          : 0
        if (
          Math.abs(surface.verticalLegIvDifference - expectedDifference) > 1e-9
        ) {
          refinement.addIssue({
            code: "custom",
            path: ["analysis", "optionSurfaces", surfaceIndex, "verticalLegIvDifference"],
            message: "Leg IV difference must equal average buy-leg IV minus average sell-leg IV",
          })
        }
      }
    })
    report.result.proposals.forEach((proposal, proposalIndex) => {
      const evaluationIndex = report.analysis.candidateEvaluations.findIndex(
        ({ underlying }) => underlying === proposal.candidate.underlying,
      )
      const evaluation = report.analysis.candidateEvaluations[evaluationIndex]
      if (evaluation === undefined) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "candidateEvaluations"],
          message: "Every proposal requires candidate diagnostics",
        })
        return
      }
      if (evaluation.legs.length !== proposal.candidate.legs.length ||
        evaluation.legs.some((leg, legIndex) => {
          const candidateLeg = proposal.candidate.legs[legIndex]
          return candidateLeg === undefined ||
            leg.contractSymbol !== candidateLeg.contractSymbol ||
            leg.positionIntent !== candidateLeg.positionIntent ||
            leg.ratioQuantity !== candidateLeg.ratioQuantity
        })) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "candidateEvaluations", evaluationIndex, "legs"],
          message: `Candidate diagnostics must match proposal ${proposalIndex + 1}`,
        })
      }
    })
  })

export type ResearchReportV7 = Readonly<z.infer<typeof researchReportV7Schema>>
