import {
  createBacktestDatasetDefinitionV2,
  type BacktestDatasetDefinitionV2,
} from "../../src/backtest/dataset-v2.js"
import type { ResearchSnapshotStrategyManifestV1 } from "../../src/contracts/research-market-snapshot-v1.js"
import { CURRENT_STRATEGY_MANIFEST } from "../../src/strategy/strategy-registry.js"

export const createSyntheticStrategyManifest = (
  underlying = "SPY",
): ResearchSnapshotStrategyManifestV1 => ({
  ...structuredClone(CURRENT_STRATEGY_MANIFEST),
  underlying,
  components: {
    ...structuredClone(CURRENT_STRATEGY_MANIFEST.components),
    universePolicy: {
      componentId: `validate${underlying}OptionUniverseV1`,
      componentVersion:
        CURRENT_STRATEGY_MANIFEST.components.universePolicy.componentVersion,
    },
  },
})

export const createBacktestDatasetDefinitionV2Fixture = (
  overrides: Partial<{
    strategyManifest: ResearchSnapshotStrategyManifestV1
    fromDate: string
    toDate: string
    optionSymbols: readonly string[]
    requestStartedAt: string
  }> = {},
): BacktestDatasetDefinitionV2 =>
  createBacktestDatasetDefinitionV2({
    strategyManifest:
      overrides.strategyManifest ?? CURRENT_STRATEGY_MANIFEST,
    fromDate: overrides.fromDate ?? "2024-06-03",
    toDate: overrides.toDate ?? "2024-06-04",
    optionSymbols:
      overrides.optionSymbols ?? [
        "SPY240621C00530000",
        "SPY240621C00535000",
      ],
    requestStartedAt:
      overrides.requestStartedAt ?? "2024-06-05T10:00:00.000Z",
  })
