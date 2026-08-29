import { describe, expect, it } from "vitest"

import {
  buildOptionUniverseSnapshotV1,
  buildUnderlyingSessionSnapshotV1,
  validateResearchSnapshotPairV1,
} from "../src/contracts/research-market-snapshot-builders-v1.js"
import {
  computeOptionUniverseSnapshotIdV1,
  computeUnderlyingSessionSnapshotIdV1,
  optionUniverseSnapshotV1Schema,
  underlyingSessionSnapshotV1Schema,
} from "../src/contracts/research-market-snapshot-v1.js"
import {
  createOptionUniverseSnapshotInputV1,
  createUnderlyingSnapshotInputV1,
} from "./fixtures/research-market-snapshot-v1.js"

const buildUnderlying = () => {
  const result = buildUnderlyingSessionSnapshotV1(
    createUnderlyingSnapshotInputV1(),
  )
  expect(result.success).toBe(true)
  if (!result.success) throw new Error(result.reasons.join(","))
  return result.snapshot
}

const buildOptionUniverse = () => {
  const underlying = buildUnderlying()
  const result = buildOptionUniverseSnapshotV1(
    underlying,
    createOptionUniverseSnapshotInputV1(),
  )
  expect(result.success).toBe(true)
  if (!result.success) throw new Error(result.reasons.join(","))
  return { underlying, optionUniverse: result.snapshot }
}

const allObjects = (value: unknown): object[] => {
  if (typeof value !== "object" || value === null) return []
  return [
    value,
    ...Object.values(value).flatMap((child) => allObjects(child)),
  ]
}

describe("research market snapshot V1", () => {
  it("builds canonical content-addressed SPY snapshots", () => {
    const { underlying, optionUniverse } = buildOptionUniverse()

    expect(underlying.snapshotId).toBe(
      "dd97255c7891b2f20d39ae273fa82daedf770cdfd0949de55380ca1083cd9e32",
    )
    expect(optionUniverse.snapshotId).toBe(
      "dd2547346e4d6c1604902ed41342224ac504383599d8fea9ae7820fe9515fef7",
    )
    expect(optionUniverse.underlyingSnapshotId).toBe(underlying.snapshotId)
    expect(underlying.dailyBars).toHaveLength(50)
    expect(underlying.minuteBars).toHaveLength(30)
    expect(optionUniverse.contracts.map(({ contractSymbol }) => contractSymbol))
      .toEqual([
        "SPY260911C00600000",
        "SPY260925P00550000",
      ])
    expect(
      optionUniverse.contracts.find(
        ({ contractSymbol }) => contractSymbol === "SPY260911C00600000",
      ),
    ).toMatchObject({
      tradable: false,
      exerciseStyle: "EUROPEAN",
      multiplier: 50,
    })
    expect(underlyingSessionSnapshotV1Schema.safeParse(underlying).success).toBe(
      true,
    )
    expect(optionUniverseSnapshotV1Schema.safeParse(optionUniverse).success).toBe(
      true,
    )
    expect(validateResearchSnapshotPairV1(underlying, optionUniverse).success)
      .toBe(true)
    expect(allObjects(underlying).every(Object.isFrozen)).toBe(true)
    expect(allObjects(optionUniverse).every(Object.isFrozen)).toBe(true)
  })

  it("is invariant to provider response ordering", () => {
    const baseline = buildOptionUniverse()
    const underlyingInput = createUnderlyingSnapshotInputV1()
    underlyingInput.session.previousSessionDates.reverse()
    underlyingInput.dailyBars.reverse()
    underlyingInput.minuteBars.reverse()
    const reorderedUnderlying = buildUnderlyingSessionSnapshotV1(underlyingInput)
    expect(reorderedUnderlying.success).toBe(true)
    if (!reorderedUnderlying.success) return

    const optionInput = createOptionUniverseSnapshotInputV1()
    optionInput.requestedContractSymbols.reverse()
    optionInput.contracts.reverse()
    const reorderedOption = buildOptionUniverseSnapshotV1(
      reorderedUnderlying.snapshot,
      optionInput,
    )
    expect(reorderedOption.success).toBe(true)
    if (!reorderedOption.success) return

    expect(reorderedUnderlying.snapshot).toEqual(baseline.underlying)
    expect(reorderedOption.snapshot).toEqual(baseline.optionUniverse)
  })

  it("rejects duplicate or incomplete underlying records with bounded reasons", () => {
    const duplicate = createUnderlyingSnapshotInputV1()
    duplicate.session.previousSessionDates[1] =
      duplicate.session.previousSessionDates[0]!
    duplicate.dailyBars[1] = {
      ...duplicate.dailyBars[1]!,
      sessionDate: duplicate.dailyBars[0]!.sessionDate,
    }
    expect(buildUnderlyingSessionSnapshotV1(duplicate)).toEqual({
      success: false,
      reasons: ["DUPLICATE_RECORD"],
    })

    const incomplete = createUnderlyingSnapshotInputV1()
    incomplete.minuteBars.pop()
    incomplete.pagination.dailyBars = "NEXT_PAGE_TOKEN_PRESENT"
    expect(buildUnderlyingSessionSnapshotV1(incomplete)).toEqual({
      success: false,
      reasons: ["DATA_INCOMPLETE"],
    })
  })

  it("rejects invalid session evidence, relabeled daily bars, and partial minutes", () => {
    const weekend = createUnderlyingSnapshotInputV1()
    weekend.session.previousSessionDates[0] = "2026-06-20"
    weekend.dailyBars[0] = {
      ...weekend.dailyBars[0]!,
      sessionDate: "2026-06-20",
      startedAt: "2026-06-20T20:00:00.000Z",
    }
    expect(buildUnderlyingSessionSnapshotV1(weekend)).toEqual({
      success: false,
      reasons: ["DATA_INCOMPLETE"],
    })

    const relabeled = createUnderlyingSnapshotInputV1()
    relabeled.dailyBars[0] = {
      ...relabeled.dailyBars[0]!,
      startedAt: "2020-01-02T20:00:00.000Z",
    }
    expect(buildUnderlyingSessionSnapshotV1(relabeled)).toEqual({
      success: false,
      reasons: ["SNAPSHOT_INVALID"],
    })

    const partialMinute = createUnderlyingSnapshotInputV1()
    partialMinute.sources.minuteBars.retrievedAt =
      "2026-08-28T13:59:59.000Z"
    expect(buildUnderlyingSessionSnapshotV1(partialMinute)).toEqual({
      success: false,
      reasons: ["DATA_INCOMPLETE"],
    })
  })

  it("rejects stale and future-dated underlying observations", () => {
    const stale = createUnderlyingSnapshotInputV1()
    stale.underlyingQuote.providerTimestamp = "2026-08-28T13:59:58.000Z"
    expect(buildUnderlyingSessionSnapshotV1(stale)).toEqual({
      success: false,
      reasons: ["OBSERVATION_STALE"],
    })

    const future = createUnderlyingSnapshotInputV1()
    future.underlyingQuote.providerTimestamp = "2026-08-28T14:01:00.001Z"
    expect(buildUnderlyingSessionSnapshotV1(future)).toEqual({
      success: false,
      reasons: ["OBSERVATION_FROM_FUTURE"],
    })

    const afterRetrieval = createUnderlyingSnapshotInputV1()
    afterRetrieval.underlyingQuote.providerTimestamp =
      "2026-08-28T14:00:55.001Z"
    expect(buildUnderlyingSessionSnapshotV1(afterRetrieval)).toEqual({
      success: false,
      reasons: ["OBSERVATION_FROM_FUTURE"],
    })
  })

  it("rejects malformed topology, cross-symbol data, and unknown fields", () => {
    const malformed = createUnderlyingSnapshotInputV1()
    malformed.minuteBars[2] = {
      ...malformed.minuteBars[2]!,
      startedAt: "2026-08-28T13:33:00.000Z",
    }
    expect(buildUnderlyingSessionSnapshotV1(malformed)).toEqual({
      success: false,
      reasons: ["DUPLICATE_RECORD"],
    })

    expect(
      buildUnderlyingSessionSnapshotV1({
        ...createUnderlyingSnapshotInputV1(),
        underlying: "QQQ",
      }),
    ).toEqual({ success: false, reasons: ["UNDERLYING_MISMATCH"] })
    expect(
      buildUnderlyingSessionSnapshotV1({
        ...createUnderlyingSnapshotInputV1(),
        credentials: "secret",
      }),
    ).toEqual({ success: false, reasons: ["INPUT_INVALID"] })
  })

  it("detects content tampering through the full snapshot digest", () => {
    const underlying = structuredClone(buildUnderlying())
    underlying.underlyingQuote.bidMicrosPerShare += 1
    expect(underlyingSessionSnapshotV1Schema.safeParse(underlying).success).toBe(
      false,
    )
  })

  it("retains a zero-bid option for downstream eligibility screening", () => {
    const underlying = buildUnderlying()
    const input = createOptionUniverseSnapshotInputV1()
    input.contracts[0]!.quote.bidCentsPerShare = 0
    const result = buildOptionUniverseSnapshotV1(underlying, input)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(
      result.snapshot.contracts.find(
        ({ contractSymbol }) => contractSymbol === "SPY260925P00550000",
      )?.quote,
    ).toEqual({
      providerTimestamp: "2026-08-28T14:00:44.000Z",
      bidCentsPerShare: 0,
      askCentsPerShare: 230,
    })
  })

  it("requires complete option coverage and matching identities", () => {
    const underlying = buildUnderlying()
    const completeInput = createOptionUniverseSnapshotInputV1()
    completeInput.requestedContractSymbols.pop()
    const incomplete = {
      ...completeInput,
      contractPaginationTermination: "NEXT_PAGE_TOKEN_PRESENT",
    }
    expect(buildOptionUniverseSnapshotV1(underlying, incomplete)).toEqual({
      success: false,
      reasons: ["DATA_INCOMPLETE"],
    })

    const drifted = createOptionUniverseSnapshotInputV1()
    drifted.contracts[0] = {
      ...drifted.contracts[0]!,
      expirationDate: "2026-09-24",
    }
    expect(buildOptionUniverseSnapshotV1(underlying, drifted)).toEqual({
      success: false,
      reasons: ["IDENTITY_MISMATCH"],
    })
  })

  it("rejects option cross-symbol, missing metric, stale quote, and old OI", () => {
    const underlying = buildUnderlying()
    const crossSymbol = createOptionUniverseSnapshotInputV1()
    const qqq = {
      ...crossSymbol.contracts[0]!,
      contractSymbol: "QQQ260925P00550000",
    }
    expect(
      buildOptionUniverseSnapshotV1(underlying, {
        ...crossSymbol,
        requestedContractSymbols: [
          "QQQ260925P00550000",
          crossSymbol.requestedContractSymbols[1],
        ],
        contracts: [qqq, crossSymbol.contracts[1]],
      }),
    ).toEqual({ success: false, reasons: ["INPUT_INVALID"] })

    const missingMetric = createOptionUniverseSnapshotInputV1()
    const withoutGreeks = structuredClone(missingMetric) as unknown as {
      contracts: Array<Record<string, unknown>>
    }
    delete withoutGreeks.contracts[0]!.greeks
    expect(buildOptionUniverseSnapshotV1(underlying, withoutGreeks)).toEqual({
      success: false,
      reasons: ["INPUT_INVALID"],
    })

    const stale = createOptionUniverseSnapshotInputV1()
    stale.contracts[0]!.quote.providerTimestamp = "2026-08-28T13:59:59.000Z"
    stale.contracts[1]!.openInterest.asOfDate = "2026-08-20"
    expect(buildOptionUniverseSnapshotV1(underlying, stale)).toEqual({
      success: false,
      reasons: ["OBSERVATION_STALE"],
    })
  })

  it("rechecks linked open-interest age when decoding a snapshot pair", () => {
    const { underlying, optionUniverse } = buildOptionUniverse()
    const changed = structuredClone(optionUniverse)
    changed.contracts[0]!.openInterest.asOfDate = "2026-08-20"
    const { snapshotId: _snapshotId, ...content } = changed
    const recomputed = {
      ...content,
      snapshotId: computeOptionUniverseSnapshotIdV1(content),
    }
    expect(optionUniverseSnapshotV1Schema.safeParse(recomputed).success).toBe(
      true,
    )
    expect(validateResearchSnapshotPairV1(underlying, recomputed)).toEqual({
      success: false,
      reason: "OPTION_UNIVERSE_SNAPSHOT_INVALID",
    })
  })

  it("rejects option observations timestamped after their source response", () => {
    const underlying = buildUnderlying()
    const quoteAfterRetrieval = createOptionUniverseSnapshotInputV1()
    quoteAfterRetrieval.contracts[0]!.quote.providerTimestamp =
      "2026-08-28T14:00:58.001Z"
    expect(
      buildOptionUniverseSnapshotV1(underlying, quoteAfterRetrieval),
    ).toEqual({
      success: false,
      reasons: ["OBSERVATION_FROM_FUTURE"],
    })

    const volumeAfterRetrieval = createOptionUniverseSnapshotInputV1()
    volumeAfterRetrieval.contracts[0]!.currentSessionVolume.providerTimestamp =
      "2026-08-28T14:00:58.001Z"
    expect(
      buildOptionUniverseSnapshotV1(underlying, volumeAfterRetrieval),
    ).toEqual({
      success: false,
      reasons: ["OBSERVATION_FROM_FUTURE"],
    })
  })

  it("preserves declared failure ordering when several option checks fail", () => {
    const underlying = buildUnderlying()
    const input = createOptionUniverseSnapshotInputV1()
    input.requestedContractSymbols[1] = input.requestedContractSymbols[0]!
    input.contracts[1] = structuredClone(input.contracts[0]!)
    input.contracts[0]!.quote.providerTimestamp = "2026-08-28T14:02:00.000Z"
    expect(buildOptionUniverseSnapshotV1(underlying, input)).toEqual({
      success: false,
      reasons: ["DUPLICATE_RECORD", "OBSERVATION_FROM_FUTURE"],
    })
  })

  it("detects pair mismatches between independently valid snapshots", () => {
    const original = buildOptionUniverse()
    const changedInput = createUnderlyingSnapshotInputV1()
    changedInput.underlyingQuote.bidMicrosPerShare += 1
    const changed = buildUnderlyingSessionSnapshotV1(changedInput)
    expect(changed.success).toBe(true)
    if (!changed.success) return

    expect(
      validateResearchSnapshotPairV1(
        changed.snapshot,
        original.optionUniverse,
      ),
    ).toEqual({ success: false, reason: "SNAPSHOT_LINK_MISMATCH" })
  })

  it("rejects a recomputed digest when semantic content is invalid", () => {
    const snapshot = structuredClone(buildUnderlying())
    snapshot.session.previousSessionDates.reverse()
    const { snapshotId: _snapshotId, ...content } = snapshot
    const recomputed = {
      ...content,
      snapshotId: computeUnderlyingSessionSnapshotIdV1(content),
    }

    expect(underlyingSessionSnapshotV1Schema.safeParse(recomputed).success).toBe(
      false,
    )
  })
})
