import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  OPTION_UNIVERSE_SNAPSHOT_BUILD_FAILURE_CODES,
  UNDERLYING_SNAPSHOT_BUILD_FAILURE_CODES,
  buildOptionUniverseSnapshotV1,
  buildUnderlyingSessionSnapshotV1,
} from "../src/contracts/research-market-snapshot-builders-v1.js"
import {
  RESEARCH_MARKET_SNAPSHOT_CONTRACT_VERSION,
  RESEARCH_MARKET_SNAPSHOT_NORMALIZATION_VERSION,
  computeUnderlyingSessionSnapshotIdV1,
  underlyingSessionSnapshotV1Schema,
} from "../src/contracts/research-market-snapshot-v1.js"
import {
  createOptionUniverseSnapshotInputV1,
  createUnderlyingSnapshotInputV1,
} from "./fixtures/research-market-snapshot-v1.js"

describe("research snapshot compatibility boundary", () => {
  it("keeps persisted V1 decoding independent of current registry state", () => {
    const decoderSource = readFileSync(
      "src/contracts/research-market-snapshot-v1.ts",
      "utf8",
    )
    const builderSource = readFileSync(
      "src/contracts/research-market-snapshot-builders-v1.ts",
      "utf8",
    )

    expect(decoderSource).not.toContain("strategy-registry")
    expect(builderSource).toContain("strategy-registry")
  })

  it("decodes an embedded historical manifest but rejects it for new construction", () => {
    const built = buildUnderlyingSessionSnapshotV1(
      createUnderlyingSnapshotInputV1(),
    )
    expect(built.success).toBe(true)
    if (!built.success) return

    const original = structuredClone(built.snapshot)
    const historicalManifest = {
      ...original.strategyManifest,
      components: {
        ...original.strategyManifest.components,
        featureCalculation: {
          ...original.strategyManifest.components.featureCalculation,
          componentId: "historical-feature-component",
        },
      },
    }
    const { snapshotId: _snapshotId, ...originalContent } = original
    const content = {
      ...originalContent,
      strategyManifest: historicalManifest,
    }
    const historical = {
      ...content,
      snapshotId: computeUnderlyingSessionSnapshotIdV1(content),
    }

    expect(underlyingSessionSnapshotV1Schema.safeParse(historical).success).toBe(
      true,
    )

    const currentInput = {
      ...createUnderlyingSnapshotInputV1(),
      strategyManifest: historicalManifest,
    }
    expect(buildUnderlyingSessionSnapshotV1(currentInput)).toEqual({
      success: false,
      reasons: ["STRATEGY_MANIFEST_INCOMPATIBLE"],
    })
  })

  it("rejects raw payloads and callback-like extensions at strict boundaries", () => {
    const input = createUnderlyingSnapshotInputV1()
    expect(
      buildUnderlyingSessionSnapshotV1({
        ...input,
        rawProviderPayload: { authorization: "secret" },
      }),
    ).toEqual({ success: false, reasons: ["INPUT_INVALID"] })

    const built = buildUnderlyingSessionSnapshotV1(input)
    expect(built.success).toBe(true)
    if (!built.success) return
    expect(
      underlyingSessionSnapshotV1Schema.safeParse({
        ...built.snapshot,
        callback: "model-selected",
      }).success,
    ).toBe(false)
  })

  it("exposes immutable versions and bounded ordered failure sets", () => {
    expect(RESEARCH_MARKET_SNAPSHOT_CONTRACT_VERSION).toBe("1.0.0")
    expect(RESEARCH_MARKET_SNAPSHOT_NORMALIZATION_VERSION).toBe("1.0.0")
    expect(Object.isFrozen(UNDERLYING_SNAPSHOT_BUILD_FAILURE_CODES)).toBe(true)
    expect(Object.isFrozen(OPTION_UNIVERSE_SNAPSHOT_BUILD_FAILURE_CODES)).toBe(
      true,
    )
    expect(new Set(UNDERLYING_SNAPSHOT_BUILD_FAILURE_CODES).size).toBe(
      UNDERLYING_SNAPSHOT_BUILD_FAILURE_CODES.length,
    )
    expect(new Set(OPTION_UNIVERSE_SNAPSHOT_BUILD_FAILURE_CODES).size).toBe(
      OPTION_UNIVERSE_SNAPSHOT_BUILD_FAILURE_CODES.length,
    )
  })

  it("keeps option construction linked without duplicating the manifest", () => {
    const underlying = buildUnderlyingSessionSnapshotV1(
      createUnderlyingSnapshotInputV1(),
    )
    expect(underlying.success).toBe(true)
    if (!underlying.success) return
    const optionUniverse = buildOptionUniverseSnapshotV1(
      underlying.snapshot,
      createOptionUniverseSnapshotInputV1(),
    )
    expect(optionUniverse.success).toBe(true)
    if (!optionUniverse.success) return

    expect(optionUniverse.snapshot.underlyingSnapshotId).toBe(
      underlying.snapshot.snapshotId,
    )
    expect(optionUniverse.snapshot).not.toHaveProperty("strategyManifest")
  })
})
