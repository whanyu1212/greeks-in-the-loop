import { canonicalJsonSha256 } from "../shared/canonical-json.js"
import type {
  BacktestExperimentV2,
  DatasetManifestV2,
} from "./contracts-v2.js"
import { GOLDEN_TECH_OPTIONS_UNIVERSE_V1 } from "./golden-universe-v1.js"

export type BacktestV2PreflightReport = Readonly<{
  reportVersion: "2.0.0"
  capability: "SELECTION_PREFLIGHT"
  status: "READY"
  experimentId: string
  runId: string
  experimentHash: string
  datasetId: string
  datasetHash: string
  evidenceTier: "FIXTURE_SELECTION_ONLY"
  selectedDateRange: Readonly<{ startDate: string; endDate: string }>
  selectedSymbols: readonly string[]
  selectedSessionDates: readonly string[]
  decisionTimes: readonly string[]
  counts: Readonly<{
    symbols: number
    sessions: number
    decisionTimesPerSession: number
    scheduledDecisionEvaluations: number
  }>
  nextRequiredCapability: "HISTORICAL_CHAIN_REPLAY"
  warnings: readonly [
    "PREFLIGHT_ONLY_NO_OPTION_QUOTES_FILLS_OR_PNL",
  ]
}>

export const runBacktestV2Preflight = (
  experiment: BacktestExperimentV2,
  dataset: DatasetManifestV2,
): BacktestV2PreflightReport => {
  if (experiment.universeId !== dataset.universeId) {
    throw new Error("Experiment and dataset universe IDs do not match")
  }

  const selection = experiment.replaySelection
  if (
    selection.startDate < dataset.startDate ||
    selection.endDate > dataset.endDate
  ) {
    throw new Error(
      `Replay range ${selection.startDate}..${selection.endDate} is outside dataset coverage ${dataset.startDate}..${dataset.endDate}`,
    )
  }

  const covered = new Set(dataset.coveredSymbols)
  const uncovered = selection.symbols.filter((value: string) => !covered.has(value))
  if (uncovered.length > 0) {
    throw new Error(`Dataset does not cover requested symbols: ${uncovered.join(", ")}`)
  }

  const selectedSessionDates = dataset.sessionDates
    .filter(
      (value: string) =>
        value >= selection.startDate && value <= selection.endDate,
    )
    .toSorted()
  if (selectedSessionDates.length === 0) {
    throw new Error("Replay selection contains no covered trading sessions")
  }

  const requested = new Set(selection.symbols)
  const selectedSymbols = GOLDEN_TECH_OPTIONS_UNIVERSE_V1.filter((value) =>
    requested.has(value),
  )
  const decisionTimes = selection.decisionTimes.toSorted()
  const experimentHash = canonicalJsonSha256(experiment)
  const datasetHash = canonicalJsonSha256(dataset)
  const runId = canonicalJsonSha256({ datasetHash, experimentHash })

  return {
    reportVersion: "2.0.0",
    capability: "SELECTION_PREFLIGHT",
    status: "READY",
    experimentId: experiment.experimentId,
    runId,
    experimentHash,
    datasetId: dataset.datasetId,
    datasetHash,
    evidenceTier: dataset.evidenceTier,
    selectedDateRange: {
      startDate: selection.startDate,
      endDate: selection.endDate,
    },
    selectedSymbols,
    selectedSessionDates,
    decisionTimes,
    counts: {
      symbols: selectedSymbols.length,
      sessions: selectedSessionDates.length,
      decisionTimesPerSession: decisionTimes.length,
      scheduledDecisionEvaluations:
        selectedSymbols.length * selectedSessionDates.length * decisionTimes.length,
    },
    nextRequiredCapability: "HISTORICAL_CHAIN_REPLAY",
    warnings: ["PREFLIGHT_ONLY_NO_OPTION_QUOTES_FILLS_OR_PNL"],
  }
}
