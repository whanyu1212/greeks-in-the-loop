import { describe, expect, it } from "vitest"

import type { ResearchSnapshotProviderV1 } from "../src/market-data/alpaca-research-snapshot-provider-v1.js"
import { runApplicationResearchScreeningAuditV1 } from "../src/research/research-screening-audit-runtime-v1.js"
import { createAuditSnapshotPairV1 } from "./fixtures/research-screening-audit-v1.js"

const SESSION_DATE = "2026-08-28"
const SLOT_STARTED_AT = "2026-08-28T14:00:00.000Z"
const signal = new AbortController().signal

const clock = (...values: number[]) => {
  let index = 0
  return () => values[index++] ?? values.at(-1) ?? 0
}

const successfulProvider = (): ResearchSnapshotProviderV1 => {
  const pair = createAuditSnapshotPairV1()
  return {
    capture: async () => ({
      success: true,
      underlying: pair.underlying,
      optionUniverse: pair.optionUniverse,
    }),
  }
}

describe("application research screening audit runtime V1", () => {
  it("captures and screens one validated snapshot pair with bounded durations", async () => {
    const audit = await runApplicationResearchScreeningAuditV1({
      provider: successfulProvider(),
      sessionDate: SESSION_DATE,
      slotStartedAt: SLOT_STARTED_AT,
      signal,
      nowMs: clock(0, 250, 250, 255),
    })

    expect(audit).toMatchObject({
      status: "SCREENED",
      captureDurationMs: 250,
      screeningDurationMs: 5,
    })
    if (audit.status !== "SCREENED") throw new Error("Expected screened audit")
    const pair = createAuditSnapshotPairV1()
    expect(audit.inputIdentity).toMatchObject({
      underlyingSnapshotId: pair.underlying.snapshotId,
      optionUniverseSnapshotId: pair.optionUniverse.snapshotId,
    })
  })

  it("preserves bounded provider failure reasons", async () => {
    const provider: ResearchSnapshotProviderV1 = {
      capture: async () => ({
        success: false,
        reasons: ["PROVIDER_RATE_LIMITED", "PAGINATION_INCOMPLETE"],
      }),
    }

    await expect(runApplicationResearchScreeningAuditV1({
      provider,
      sessionDate: SESSION_DATE,
      slotStartedAt: SLOT_STARTED_AT,
      signal,
      nowMs: clock(10, 35),
    })).resolves.toEqual({
      status: "CAPTURE_UNAVAILABLE",
      captureDurationMs: 25,
      reasons: ["PROVIDER_RATE_LIMITED", "PAGINATION_INCOMPLETE"],
    })
  })

  it.each([
    [new DOMException("cancelled", "AbortError"), "AUDIT_CANCELLED"],
    [new DOMException("timed out", "TimeoutError"), "AUDIT_DEADLINE_EXCEEDED"],
  ] as const)("maps aborts to %s", async (reason, expected) => {
    const controller = new AbortController()
    controller.abort(reason)
    const provider: ResearchSnapshotProviderV1 = {
      capture: async () => { throw reason },
    }

    const audit = await runApplicationResearchScreeningAuditV1({
      provider,
      sessionDate: SESSION_DATE,
      slotStartedAt: SLOT_STARTED_AT,
      signal: controller.signal,
      nowMs: clock(0, 3),
    })

    expect(audit).toEqual({
      status: "CAPTURE_UNAVAILABLE",
      captureDurationMs: 3,
      reasons: [expected],
    })
  })

  it("bounds unexpected capture and screening failures", async () => {
    const captureAudit = await runApplicationResearchScreeningAuditV1({
      provider: { capture: async () => { throw new Error("raw provider error") } },
      sessionDate: SESSION_DATE,
      slotStartedAt: SLOT_STARTED_AT,
      signal,
      nowMs: clock(0, 1),
    })
    const screeningAudit = await runApplicationResearchScreeningAuditV1({
      provider: successfulProvider(),
      sessionDate: SESSION_DATE,
      slotStartedAt: SLOT_STARTED_AT,
      signal,
      nowMs: clock(0, 2, 2, 4),
      screen: () => { throw new Error("raw screening error") },
    })

    expect(captureAudit).toEqual({
      status: "CAPTURE_UNAVAILABLE",
      captureDurationMs: 1,
      reasons: ["UNEXPECTED_FAILURE"],
    })
    expect(screeningAudit).toMatchObject({
      status: "SCREENING_UNAVAILABLE",
      captureDurationMs: 2,
      screeningDurationMs: 2,
      reason: "UNEXPECTED_FAILURE",
    })
  })
})
