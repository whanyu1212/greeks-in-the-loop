import { z } from "zod"

import {
  GOLDEN_TECH_OPTIONS_UNIVERSE_ID_V1,
  goldenTechOptionsSymbolSetV1,
} from "./golden-universe-v1.js"

const date = z.iso.date()
const boundedIdentifier = z.string().trim().min(1).max(128)
const symbol = z.string().trim().regex(/^[A-Z][A-Z0-9.]{0,9}$/)

const uniqueStrings = (values: readonly string[]) =>
  new Set(values).size === values.length

export const datasetManifestV2Schema = z
  .object({
    datasetVersion: z.literal("2.0.0"),
    datasetId: boundedIdentifier,
    evidenceTier: z.literal("FIXTURE_SELECTION_ONLY"),
    universeId: z.literal(GOLDEN_TECH_OPTIONS_UNIVERSE_ID_V1),
    timezone: z.literal("America/New_York"),
    startDate: date,
    endDate: date,
    coveredSymbols: z.array(symbol).min(1).max(48),
    sessionDates: z.array(date).min(1).max(1_000),
    source: z.literal("COMMITTED_FIXTURE"),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.startDate > manifest.endDate) {
      context.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "endDate must be on or after startDate",
      })
    }
    if (!uniqueStrings(manifest.coveredSymbols)) {
      context.addIssue({
        code: "custom",
        path: ["coveredSymbols"],
        message: "coveredSymbols must not contain duplicates",
      })
    }
    if (!uniqueStrings(manifest.sessionDates)) {
      context.addIssue({
        code: "custom",
        path: ["sessionDates"],
        message: "sessionDates must not contain duplicates",
      })
    }
    manifest.coveredSymbols.forEach((value, index) => {
      if (!goldenTechOptionsSymbolSetV1.has(value)) {
        context.addIssue({
          code: "custom",
          path: ["coveredSymbols", index],
          message: `${value} is not in ${GOLDEN_TECH_OPTIONS_UNIVERSE_ID_V1}`,
        })
      }
    })
    manifest.sessionDates.forEach((value, index) => {
      if (value < manifest.startDate || value > manifest.endDate) {
        context.addIssue({
          code: "custom",
          path: ["sessionDates", index],
          message: "session date is outside manifest coverage",
        })
      }
    })
  })

export const backtestExperimentV2Schema = z
  .object({
    backtestVersion: z.literal("2.0.0"),
    experimentId: boundedIdentifier,
    capability: z.literal("SELECTION_PREFLIGHT"),
    datasetManifestRef: z.string().trim().min(1).max(1_024),
    universeId: z.literal(GOLDEN_TECH_OPTIONS_UNIVERSE_ID_V1),
    replaySelection: z
      .object({
        startDate: date,
        endDate: date,
        timezone: z.literal("America/New_York"),
        symbols: z.array(symbol).min(1).max(48),
        session: z.literal("REGULAR"),
        decisionTimes: z
          .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
          .min(1)
          .max(16),
      })
      .strict(),
    strategy: z
      .object({
        strategyVersion: boundedIdentifier,
        structures: z
          .array(z.enum(["BULL_CALL_SPREAD", "BEAR_PUT_SPREAD"]))
          .min(1)
          .max(2),
      })
      .strict(),
    execution: z
      .object({
        priceMode: z.literal("BID_ASK"),
        multiLegFill: z.literal("ATOMIC"),
        missingQuote: z.enum(["NO_FILL", "INCOMPLETE_RUN"]),
        latencyMilliseconds: z.number().int().nonnegative().max(60_000),
        slippageHalfCentsPerLeg: z.number().int().nonnegative().max(10_000),
        commissionCentsPerContract: z.number().int().nonnegative().safe(),
      })
      .strict(),
    portfolio: z
      .object({
        initialCapitalCents: z.number().int().positive().safe(),
        quantity: z.literal(1),
        maxConcurrentPositions: z.literal(1),
        endOfTest: z.literal("LIQUIDATE_AT_END"),
      })
      .strict(),
  })
  .strict()
  .superRefine((experiment, context) => {
    const selection = experiment.replaySelection
    if (selection.startDate > selection.endDate) {
      context.addIssue({
        code: "custom",
        path: ["replaySelection", "endDate"],
        message: "endDate must be on or after startDate",
      })
    }
    if (!uniqueStrings(selection.symbols)) {
      context.addIssue({
        code: "custom",
        path: ["replaySelection", "symbols"],
        message: "symbols must not contain duplicates",
      })
    }
    if (!uniqueStrings(selection.decisionTimes)) {
      context.addIssue({
        code: "custom",
        path: ["replaySelection", "decisionTimes"],
        message: "decisionTimes must not contain duplicates",
      })
    }
    selection.symbols.forEach((value, index) => {
      if (!goldenTechOptionsSymbolSetV1.has(value)) {
        context.addIssue({
          code: "custom",
          path: ["replaySelection", "symbols", index],
          message: `${value} is not in ${GOLDEN_TECH_OPTIONS_UNIVERSE_ID_V1}`,
        })
      }
    })
  })

export type DatasetManifestV2 = z.infer<typeof datasetManifestV2Schema>
export type BacktestExperimentV2 = z.infer<typeof backtestExperimentV2Schema>
