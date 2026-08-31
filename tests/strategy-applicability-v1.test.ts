import { describe, expect, it } from "vitest"

import type { UnderlyingSessionSnapshotV1 } from "../src/contracts/research-market-snapshot-v1.js"
import {
  assessDirectionalDebitVerticalApplicabilityForManifestV1,
  assessDirectionalDebitVerticalApplicabilityV1,
  screenSpyDirectionalDebitVerticalForManifestV1,
  screenSpyDirectionalDebitVerticalV1,
} from "../src/strategy/directional-debit-vertical-v1.js"
import {
  DIRECTIONAL_DEBIT_VERTICAL_APPLICABILITY_COMPONENT_ID,
  DIRECTIONAL_DEBIT_VERTICAL_APPLICABILITY_COMPONENT_VERSION,
  STRATEGY_APPLICABILITY_UNAVAILABLE_REASONS,
  STRATEGY_NOT_APPLICABLE_REASONS,
  strategyApplicabilityV1Schema,
} from "../src/strategy/strategy-applicability-v1.js"
import {
  createAuditContractV1,
  createAuditSnapshotPairV1,
  createEligibleAuditContractsV1,
  createHistoricalAuditSnapshotPairV1,
} from "./fixtures/research-screening-audit-v1.js"

const assess = (underlying: UnderlyingSessionSnapshotV1) =>
  assessDirectionalDebitVerticalApplicabilityV1(underlying)

const neutralPair = () => createAuditSnapshotPairV1({
  mutateUnderlying(input) {
    input.underlyingQuote.bidMicrosPerShare = 635_190_000
    input.underlyingQuote.askMicrosPerShare = 635_200_000
  },
})

const staleMinutePair = () => createAuditSnapshotPairV1({
  mutateUnderlying(input) {
    input.times.evaluatedAt = "2026-08-28T14:01:31.000Z"
  },
})

describe("StrategyApplicabilityV1", () => {
  it("freezes separate canonical reason orders", () => {
    expect(STRATEGY_NOT_APPLICABLE_REASONS).toEqual([
      "SIGNAL_NOT_ACTIONABLE",
    ])
    expect(STRATEGY_APPLICABILITY_UNAVAILABLE_REASONS).toEqual([
      "STRATEGY_MANIFEST_INCOMPATIBLE",
      "UNDERLYING_SNAPSHOT_INVALID",
      "FEATURE_INPUT_INVALID",
      "UNDERLYING_QUOTE_STALE",
      "LATEST_MINUTE_BAR_STALE",
    ])
    expect([
      STRATEGY_NOT_APPLICABLE_REASONS,
      STRATEGY_APPLICABILITY_UNAVAILABLE_REASONS,
    ].every(Object.isFrozen)).toBe(true)
  })

  it("returns bounded identity for an applicable strategy", () => {
    const pair = createAuditSnapshotPairV1()
    const result = assess(pair.underlying)

    expect(result).toMatchObject({
      applicabilityVersion: "1.0.0",
      status: "APPLICABLE",
      identity: {
        evaluatedStrategyManifest: pair.underlying.strategyManifest,
        featureComponentId: "calculateDirectionalTrendFeaturesV1",
        featureVersion: "1.0.0",
        applicabilityComponentId:
          DIRECTIONAL_DEBIT_VERTICAL_APPLICABILITY_COMPONENT_ID,
        applicabilityComponentVersion:
          DIRECTIONAL_DEBIT_VERTICAL_APPLICABILITY_COMPONENT_VERSION,
        snapshot: {
          status: "VALIDATED",
          strategyManifest: pair.underlying.strategyManifest,
          underlying: "SPY",
          underlyingSnapshotId: pair.underlying.snapshotId,
          evaluatedAt: pair.underlying.times.evaluatedAt,
        },
      },
    })
    expect([
      result,
      result.identity,
      result.identity.snapshot,
      result.identity.evaluatedStrategyManifest,
    ].every(Object.isFrozen)).toBe(true)
  })

  it.each([
    [
      "not applicable",
      () => neutralPair().underlying,
      { status: "NOT_APPLICABLE", reason: "SIGNAL_NOT_ACTIONABLE" },
    ],
    [
      "manifest unavailable",
      () => createHistoricalAuditSnapshotPairV1().underlying,
      {
        status: "UNAVAILABLE",
        reason: "STRATEGY_MANIFEST_INCOMPATIBLE",
      },
    ],
    [
      "quote freshness unavailable",
      () => staleMinutePair().underlying,
      { status: "UNAVAILABLE", reason: "UNDERLYING_QUOTE_STALE" },
    ],
  ] as const)("classifies %s without candidate inputs", (_label, input, expected) => {
    expect(assess(input())).toMatchObject(expected)
  })

  it("fails closed for invalid feature and quote inputs", () => {
    const underlying = createAuditSnapshotPairV1().underlying
    const invalidFeature = {
      ...underlying,
      dailyBars: underlying.dailyBars.slice(1),
    } as UnderlyingSessionSnapshotV1
    const staleQuote = {
      ...underlying,
      underlyingQuote: {
        ...underlying.underlyingQuote,
        providerTimestamp: "2026-08-28T13:59:00.000Z",
      },
    } as UnderlyingSessionSnapshotV1
    const malformedIdentity = {
      ...underlying,
      snapshotId: "bad",
    } as UnderlyingSessionSnapshotV1

    expect(assess(invalidFeature)).toMatchObject({
      status: "UNAVAILABLE",
      reason: "UNDERLYING_SNAPSHOT_INVALID",
    })
    expect(assess(staleQuote)).toMatchObject({
      status: "UNAVAILABLE",
      reason: "UNDERLYING_SNAPSHOT_INVALID",
    })
    expect(assess(malformedIdentity)).toMatchObject({
      status: "UNAVAILABLE",
      reason: "UNDERLYING_SNAPSHOT_INVALID",
      identity: {
        snapshot: {
          status: "INVALID",
          inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      },
    })
  })

  it("is deterministic, strict, and does not mutate inputs", () => {
    const pair = createAuditSnapshotPairV1()
    const before = structuredClone(pair.underlying)
    const first = assess(pair.underlying)
    const second = assess(pair.underlying)

    expect(second).toEqual(first)
    expect(pair.underlying).toEqual(before)
    expect(strategyApplicabilityV1Schema.safeParse({
      ...first,
      unexpected: true,
    }).success).toBe(false)
    expect(strategyApplicabilityV1Schema.safeParse({
      ...first,
      reason: "SIGNAL_NOT_ACTIONABLE",
    }).success).toBe(false)
  })

  it("keeps candidate availability downstream from applicability", () => {
    const pair = createAuditSnapshotPairV1({
      contracts: [createAuditContractV1({
        strikeCentsPerShare: 63_000,
        tradable: false,
      })],
    })

    expect(assess(pair.underlying).status).toBe("APPLICABLE")
    expect(screenSpyDirectionalDebitVerticalV1(pair)).toMatchObject({
      status: "NO_ACTION",
      reason: "NO_ELIGIBLE_SPREAD",
    })
  })

  it("distinguishes runtime registry availability from explicit replay", () => {
    const underlying = createHistoricalAuditSnapshotPairV1().underlying
    const runtime = assess(underlying)
    const replay = assessDirectionalDebitVerticalApplicabilityForManifestV1(
      underlying,
      underlying.strategyManifest,
    )

    expect(runtime).toMatchObject({
      status: "UNAVAILABLE",
      reason: "STRATEGY_MANIFEST_INCOMPATIBLE",
      identity: { evaluatedStrategyManifest: null },
    })
    expect(replay).toMatchObject({
      status: "APPLICABLE",
      identity: { evaluatedStrategyManifest: underlying.strategyManifest },
    })
    expect(replay.identity).not.toEqual(runtime.identity)
  })

  it("is independent of option-provider response ordering", () => {
    const contracts = createEligibleAuditContractsV1()
    const first = createAuditSnapshotPairV1({ contracts })
    const reordered = createAuditSnapshotPairV1({
      contracts: [...contracts].reverse(),
    })

    expect(reordered.underlying).toEqual(first.underlying)
    expect(assess(reordered.underlying)).toEqual(assess(first.underlying))
  })

  it("preserves runtime and explicit-manifest screening results", () => {
    for (const pair of [
      createAuditSnapshotPairV1(),
      neutralPair(),
      staleMinutePair(),
    ]) {
      expect(assessDirectionalDebitVerticalApplicabilityForManifestV1(
        pair.underlying,
        pair.underlying.strategyManifest,
      )).toEqual(assess(pair.underlying))
      expect(screenSpyDirectionalDebitVerticalForManifestV1(
        pair,
        pair.underlying.strategyManifest,
      )).toEqual(screenSpyDirectionalDebitVerticalV1(pair))
    }
  })
})
