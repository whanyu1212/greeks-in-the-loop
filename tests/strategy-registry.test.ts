import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  CURRENT_STRATEGY_MANIFEST,
  STATIC_STRATEGY_REGISTRY,
  checkStrategyManifestCompatibility,
  resolveStrategyManifest,
  resolveStrategyVersionCompatibility,
  resolveV1StrategyVersionCompatibility,
} from "../src/strategy/strategy-registry.js"
import {
  LEGACY_STRATEGY_VERSION,
  RUNTIME_STRATEGY_VERSIONS,
  SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
  STRATEGY_IDS,
  STRATEGY_VERSION,
  SUPPORTED_STRATEGY_VERSIONS,
} from "../src/strategy/strategy-identity.js"

const allObjects = (value: unknown): object[] => {
  if (typeof value !== "object" || value === null) return []
  return [
    value,
    ...Object.values(value).flatMap((child) => allObjects(child)),
  ]
}

const allValues = (value: unknown): unknown[] => {
  if (typeof value !== "object" || value === null) return [value]
  return [value, ...Object.values(value).flatMap((child) => allValues(child))]
}

describe("static strategy registry", () => {
  it("contains exactly one compile-time strategy and one runtime version", () => {
    expect(STRATEGY_IDS).toEqual(["spy-directional-debit-vertical"])
    expect(Object.keys(STATIC_STRATEGY_REGISTRY)).toEqual(STRATEGY_IDS)
    expect(SUPPORTED_STRATEGY_VERSIONS).toEqual(["1.0.0", "1.1.0"])
    expect(RUNTIME_STRATEGY_VERSIONS).toEqual(["1.1.0"])
    expect(LEGACY_STRATEGY_VERSION).toBe("1.0.0")
    expect(STRATEGY_VERSION).toBe("1.1.0")
  })

  it("declares the exact current SPY component manifest", () => {
    expect(CURRENT_STRATEGY_MANIFEST).toEqual({
      manifestVersion: "1.0.0",
      strategyId: "spy-directional-debit-vertical",
      strategyVersion: "1.1.0",
      underlying: "SPY",
      components: {
        universePolicy: {
          componentId: "validateSpyOptionUniverseV1",
          componentVersion: "1.0.0",
        },
        featureCalculation: {
          componentId: "spy-debit-spread-research",
          componentVersion: "1.2.0",
          authority: "RESEARCH_SKILL_POLICY",
        },
        candidateGenerationRanking: {
          componentId: "spy-debit-spread-research",
          componentVersion: "1.2.0",
          authority: "RESEARCH_SKILL_POLICY",
        },
        intentDerivation: {
          componentId: "deriveTradeIntentV1",
          componentVersion: "1.0.0",
        },
        riskRule: {
          componentId: "evaluateTradeIntentRiskV1",
          componentVersion: "1.0.0",
          evaluationVersion: "1.0.0",
        },
        exitPolicy: {
          componentId: "runBacktestReplayV1",
          componentVersion: "1.0.0",
          availability: "REPLAY_ONLY",
        },
      },
      researchPlanCompatibility: {
        kind: "LEGACY_RESEARCH_INVOCATION_V1",
        invocationVersion: "1.1.0",
        agentName: "research",
        promptVersion: "1.4.0",
        skillName: "spy-debit-spread-research",
        skillVersion: "1.2.0",
        decisionContractVersion: "1.0.0",
        reportVersion: "2.0.0",
      },
      replayCompatibility: {
        kind: "BACKTEST_REPLAY_V1",
        replayVersion: "1.0.0",
        executionModelVersion: "1.0.0",
        datasetVersion: "1.0.0",
        normalizationVersion: "1.0.0",
      },
    })
  })

  it("deep-freezes data-only identity without executable hooks", () => {
    expect(allObjects(STATIC_STRATEGY_REGISTRY).every(Object.isFrozen)).toBe(
      true,
    )
    expect(
      allValues(STATIC_STRATEGY_REGISTRY).some(
        (value) => typeof value === "function",
      ),
    ).toBe(false)
  })

  it("resolves only the current strategy for runtime use", () => {
    expect(
      resolveStrategyManifest({
        strategyId: SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
      }),
    ).toEqual({ success: true, manifest: CURRENT_STRATEGY_MANIFEST })
    expect(
      resolveStrategyManifest({
        strategyId: SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
        strategyVersion: LEGACY_STRATEGY_VERSION,
      }),
    ).toEqual({
      success: false,
      reason: "STRATEGY_VERSION_NOT_RUNTIME_SUPPORTED",
    })
  })

  it.each([
    [null, "STRATEGY_REFERENCE_INVALID"],
    [
      {
        strategyId: SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        callback: "model-selected",
      },
      "STRATEGY_REFERENCE_INVALID",
    ],
    [
      { strategyId: "unknown", strategyVersion: STRATEGY_VERSION },
      "UNKNOWN_STRATEGY_ID",
    ],
    [
      {
        strategyId: SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
        strategyVersion: "9.9.9",
      },
      "UNKNOWN_STRATEGY_VERSION",
    ],
  ] as const)("rejects an unsupported runtime reference", (input, reason) => {
    expect(resolveStrategyManifest(input)).toEqual({ success: false, reason })
  })

  it("keeps historical compatibility separate from runtime authority", () => {
    expect(
      resolveV1StrategyVersionCompatibility(LEGACY_STRATEGY_VERSION),
    ).toEqual({
      success: true,
      compatibility: {
        strategyId: SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
        strategyVersion: LEGACY_STRATEGY_VERSION,
        availability: "DECODE_ONLY",
        tradeIntentTiming: {
          startGraceMs: 120_000,
          windowDurationMs: 300_000,
        },
        researchProvenance: "NOT_RECORDED",
      },
    })
    expect(
      resolveStrategyVersionCompatibility({
        strategyId: SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
      }),
    ).toEqual({
      success: true,
      compatibility: {
        strategyId: SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        availability: "RUNTIME_AND_DECODE",
        tradeIntentTiming: {
          startGraceMs: 300_000,
          windowDurationMs: 600_000,
        },
        researchProvenance: "VERSIONED_INVOCATION",
      },
    })
  })

  it("keeps historical decoders independent of current registry state", () => {
    for (const path of [
      "src/event-ledger/ledger-event-v1.ts",
      "src/research/research-artifact.ts",
      "src/backtest/dataset-v1.ts",
      "src/backtest/replay-v1.ts",
      "src/risk/risk-evaluation-v1.ts",
      "src/risk/shadow-risk-v1.ts",
    ]) {
      expect(readFileSync(path, "utf8")).not.toContain("strategy-registry")
    }
  })

  it("rejects component-manifest drift with a bounded reason", () => {
    expect(checkStrategyManifestCompatibility(CURRENT_STRATEGY_MANIFEST)).toEqual(
      { success: true, manifest: CURRENT_STRATEGY_MANIFEST },
    )

    const drifted = structuredClone(CURRENT_STRATEGY_MANIFEST) as unknown as {
      components: { riskRule: { componentVersion: string } }
    }
    drifted.components.riskRule.componentVersion = "9.9.9"
    expect(checkStrategyManifestCompatibility(drifted)).toEqual({
      success: false,
      reason: "COMPONENT_MANIFEST_INCOMPATIBLE",
    })
  })
})
