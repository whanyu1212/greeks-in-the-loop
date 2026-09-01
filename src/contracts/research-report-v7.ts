import { z } from "zod"

import { alpacaOptionEntryLegV2Schema } from "../options/alpaca-capabilities.js"
import { optionUnderlyingV1Schema } from "../shared/alpaca-option-identity.js"
import { deriveOptionLegAggregateGreeksV1 } from "../shared/option-leg-aggregate-greeks.js"
import { researchDecisionV4Schema } from "./research-decision-v4.js"
import { researchAnalysisV6Schema } from "./research-report-v6.js"

export const RESEARCH_REPORT_V7_VERSION = "7.0.0" as const

const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const count = z.number().int().nonnegative().safe()
const finite = z.number().finite()

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
    }
    report.analysis.candidateEvaluations.forEach((evaluation, index) => {
      if (Date.parse(evaluation.observedAt) > asOf) {
        refinement.addIssue({
          code: "custom",
          path: ["analysis", "candidateEvaluations", index, "observedAt"],
          message: "Candidate diagnostics cannot follow the report time",
        })
      }
    })
    if (report.result.outcome !== "PROPOSE_TRADES") return
    const proposed = new Set(
      report.result.proposals.map(({ candidate }) => candidate.underlying),
    )
    const evaluated = report.analysis.candidateEvaluations.map(
      ({ underlying }) => underlying,
    )
    if (
      new Set(evaluated).size !== proposed.size ||
      evaluated.some((underlying) => !proposed.has(underlying))
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["analysis", "candidateEvaluations"],
        message: "Candidate diagnostics must cover proposed symbols exactly once",
      })
    }
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
