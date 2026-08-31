import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { StoredLedgerEventV1 } from "../src/event-ledger/ledger-event-v1.js"
import { createSqliteLedgerStore } from "../src/event-ledger/sqlite-ledger-store.js"
import {
  buildResearchScreeningAuditReportV1,
  loadResearchScreeningAuditReportEventsV1,
  MAX_IDENTICAL_INPUT_MISMATCH_DETAILS,
} from "../src/research/research-screening-audit-report-v1.js"
import {
  createResearchScreeningAuditReportFixtureEventsV1,
} from "./fixtures/research-screening-audit-v1.js"

const window = {
  fromSessionDate: "2026-08-28",
  toSessionDate: "2026-08-28",
} as const
const temporaryDirectories: string[] = []

const report = (events = createResearchScreeningAuditReportFixtureEventsV1()) =>
  buildResearchScreeningAuditReportV1(events, window)

const fileChecksum = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex")

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe("research screening audit aggregate report V1", () => {
  it("aggregates the stored reproduction matrix with a stable checksum", () => {
    const actual = report()

    expect(actual.cycleCounts).toEqual({
      auditEligible: 18,
      recordedAudit: 18,
      missingAudit: 0,
      unexpectedAudit: 0,
      identicalInputComparable: 5,
    })
    expect(actual.application).toMatchObject({
      statusCounts: {
        SCREENED: 15,
        CAPTURE_UNAVAILABLE: 2,
        SCREENING_UNAVAILABLE: 1,
      },
      captureFailureReasonCounts: {
        AUDIT_CANCELLED: 1,
        PROVIDER_RATE_LIMITED: 1,
        REQUEST_TIMED_OUT: 1,
      },
      screeningUnavailableReasonCounts: { FEATURE_INPUT_INVALID: 1 },
      latencyMs: {
        capture: { count: 18, min: 50, p50: 100, p95: 250, max: 250 },
        screening: { count: 16, min: 10, p50: 10, p95: 27, max: 27 },
      },
      screeningResultCounts: { SELECTED: 11, NO_ACTION: 4 },
      candidateFrequency: { selectedCycles: 11, screenedCycles: 15 },
      noActionReasonCounts: {
        MARKET_DATA_STALE: 1,
        NO_ELIGIBLE_SPREAD: 1,
        SIGNAL_NOT_ACTIONABLE: 1,
        STRATEGY_MANIFEST_INCOMPATIBLE: 1,
      },
      selectedCandidateDimensionCounts: {
        byDirection: { BULLISH: 11, BEARISH: 0 },
        bySessionRelativeCalendarDte: { 21: 11 },
        byExpirationDate: { "2026-09-18": 11 },
        byWidthCentsPerShare: { 500: 11 },
      },
    })
    expect(actual.application.firstFailureEvaluationUnitCounts).toEqual({
      byStage: {
        COMPATIBILITY: 1,
        FEATURE: 1,
        FRESHNESS: 1,
        ELIGIBILITY: 24,
        LIQUIDITY: 0,
        ECONOMICS: 0,
        RANKING: 0,
      },
      byReason: {
        CONTRACT_NOT_TRADABLE: 2,
        DELTA_OUT_OF_RANGE: 22,
        FEATURE_SIGNAL_NOT_ACTIONABLE: 1,
        STRATEGY_MANIFEST_INCOMPATIBLE: 1,
        UNDERLYING_QUOTE_STALE: 1,
      },
    })
    expect(actual.agent).toEqual({
      statusCounts: { AVAILABLE: 8, MODEL_IDENTITY_DRIFT: 2, UNAVAILABLE: 8 },
      terminalClassCounts: {
        NO_ACTION: 0,
        PRELIMINARY_RESEARCH: 0,
        PROPOSE_TRADE: 8,
      },
      unavailableReasonCounts: {
        AUDIT_CANCELLED: 1,
        INVOCATION_FAILED: 1,
        REPORT_REJECTED: 5,
        UNEXPECTED_FAILURE: 1,
      },
      modelDriftReasonCounts: { MODEL_DRIFT: 1, PROVIDER_DRIFT: 1 },
      availableInvocationIdentityCounts: [{
        invocationVersion: "1.3.0",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        count: 8,
      }],
    })
    expect(actual.comparison.classCounts).toEqual({
      IDENTICAL_INPUT_MATCH: 1,
      IDENTICAL_INPUT_FEATURE_MISMATCH: 1,
      IDENTICAL_INPUT_FILTER_MISMATCH: 1,
      IDENTICAL_INPUT_RANKING_MISMATCH: 1,
      IDENTICAL_INPUT_CANDIDATE_MISMATCH: 1,
      DIFFERENT_SNAPSHOT_TIME: 1,
      DIFFERENT_SNAPSHOT_MEMBERSHIP: 1,
      APPLICATION_CAPTURE_UNAVAILABLE: 2,
      APPLICATION_SCREENING_UNAVAILABLE: 1,
      AGENT_RESULT_UNAVAILABLE: 5,
      MODEL_IDENTITY_DRIFT: 2,
      COMPARISON_NOT_REPRESENTABLE: 1,
    })
    expect(actual.comparison.identicalInputMismatches).toMatchObject({
      total: 4,
      truncated: false,
      details: [
        { comparisonClass: "IDENTICAL_INPUT_FEATURE_MISMATCH" },
        { comparisonClass: "IDENTICAL_INPUT_FILTER_MISMATCH" },
        { comparisonClass: "IDENTICAL_INPUT_RANKING_MISMATCH" },
        { comparisonClass: "IDENTICAL_INPUT_CANDIDATE_MISMATCH" },
      ],
    })
    expect(actual.comparison.identicalInputMismatches.details[0]).not.toHaveProperty(
      "applicationResult.longContractMembershipProof",
    )
    expect(actual.checksum).toBe(
      "9006a3aea98f3880982b3078b67a21de7344e7a16d9c6f559487e92cec5797cd",
    )
  })

  it("is order-independent, date-bounded, and explicit for an empty window", () => {
    const events = createResearchScreeningAuditReportFixtureEventsV1()
    expect(report([...events].reverse())).toEqual(report(events))
    expect(buildResearchScreeningAuditReportV1(events, {
      fromSessionDate: "2026-08-29",
      toSessionDate: "2026-08-29",
    })).toMatchObject({
      sourceSequenceBounds: { firstSequence: null, lastSequence: null },
      cycleCounts: {
        auditEligible: 0,
        recordedAudit: 0,
        missingAudit: 0,
        unexpectedAudit: 0,
        identicalInputComparable: 0,
      },
      application: {
        latencyMs: {
          capture: { count: 0, min: null, p50: null, p95: null, max: null },
          screening: { count: 0, min: null, p50: null, p95: null, max: null },
        },
      },
    })
    expect(() => buildResearchScreeningAuditReportV1(events, {
      fromSessionDate: "2026-08-29",
      toSessionDate: "2026-08-28",
    })).toThrow("date range is reversed")
  })

  it("counts missing and unexpected audits without contaminating aggregates", () => {
    const events = createResearchScreeningAuditReportFixtureEventsV1()
      .filter(({ eventId }) => eventId !== "audit-report-audit-1")
      .map((event) => event.eventId !== "audit-report-start-2"
        ? event
        : {
            ...event,
            payload: {
              ...event.payload,
              initialEligibility: {
                ...(event.payload as Extract<
                  StoredLedgerEventV1,
                  { eventType: "RESEARCH_CYCLE_STARTED" }
                >["payload"]).initialEligibility!,
                researchMode: "DRY_RUN_SHADOW_ANYTIME" as const,
              },
            },
          } as StoredLedgerEventV1)

    const actual = report(events)
    expect(actual.cycleCounts).toEqual({
      auditEligible: 17,
      recordedAudit: 16,
      missingAudit: 1,
      unexpectedAudit: 1,
      identicalInputComparable: 3,
    })
    expect(actual.comparison.classCounts.IDENTICAL_INPUT_MATCH).toBe(0)
    expect(actual.comparison.classCounts.IDENTICAL_INPUT_FEATURE_MISMATCH).toBe(0)
  })

  it("uses the retained application DTE rather than unrelated cycle context", () => {
    const events = createResearchScreeningAuditReportFixtureEventsV1()
      .slice(0, 3)
      .map((event) => event.eventType !== "RESEARCH_CYCLE_STARTED"
        ? event
        : {
            ...event,
            payload: {
              ...event.payload,
              sessionDate: "2026-08-27",
              initialEligibility: {
                ...event.payload.initialEligibility!,
                sessionDate: "2026-08-27",
              },
            },
          }) as StoredLedgerEventV1[]

    const actual = buildResearchScreeningAuditReportV1(events, {
      fromSessionDate: "2026-08-27",
      toSessionDate: "2026-08-27",
    })
    expect(actual.application.selectedCandidateDimensionCounts)
      .toMatchObject({ bySessionRelativeCalendarDte: { 21: 1 } })
  })

  it("anchors paginated reads to the initial high-water sequence", async () => {
    const initial = createResearchScreeningAuditReportFixtureEventsV1()
      .filter(({ eventType }) =>
        eventType === "RESEARCH_CYCLE_STARTED" ||
        eventType === "RESEARCH_SCREENING_AUDIT_RECORDED")
    const latest = initial.at(-1)!
    const appended = {
      ...latest,
      sequence: latest.sequence + 1,
      eventId: "audit-appended-during-report",
    } as StoredLedgerEventV1
    const list = vi.fn(async (query: Parameters<
      Pick<ReturnType<typeof createSqliteLedgerStore>, "list">["list"]
    >[0]) => query.direction === "DESC"
      ? [latest]
      : [...initial, appended].filter(({ sequence }) =>
          sequence > (query.afterSequence ?? 0) &&
          sequence < (query.beforeSequence ?? Number.POSITIVE_INFINITY)))

    await expect(loadResearchScreeningAuditReportEventsV1({ list }))
      .resolves.toEqual(initial)
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({
      afterSequence: 0,
      beforeSequence: latest.sequence + 1,
    }))
  })

  it("caps mismatch details without capping the total", () => {
    const template = createResearchScreeningAuditReportFixtureEventsV1()
    const start = template.find(({ eventId }) => eventId === "audit-report-start-2")!
    const audit = template.find(({ eventId }) => eventId === "audit-report-audit-2")!
    const events = Array.from({ length: 101 }, (_, index) => {
      const cycleId = `mismatch-cycle-${index + 1}`
      return [
        {
          ...start,
          sequence: index * 2 + 1,
          eventId: `mismatch-start-${index + 1}`,
          cycleId,
          payload: { ...start.payload, cycleNumber: index + 1 },
        },
        {
          ...audit,
          sequence: index * 2 + 2,
          eventId: `mismatch-audit-${index + 1}`,
          cycleId,
        },
      ] as const
    }).flat() as StoredLedgerEventV1[]

    const mismatches = report(events).comparison.identicalInputMismatches
    expect(mismatches).toMatchObject({ total: 101, truncated: true })
    expect(mismatches.details).toHaveLength(MAX_IDENTICAL_INPUT_MISMATCH_DETAILS)
    expect(mismatches.details[0]?.sequence).toBe(2)
    expect(mismatches.details.at(-1)?.sequence).toBe(200)
  })

  it("runs the CLI against a migrated ledger without changing the database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "screening-audit-report-"))
    temporaryDirectories.push(directory)
    const ledgerPath = join(directory, "ledger.sqlite")
    const store = createSqliteLedgerStore({
      path: ledgerPath,
      knownCredentialValues: [],
    })
    await store.migrate()
    for (const storedEvent of createResearchScreeningAuditReportFixtureEventsV1()) {
      const { sequence: _sequence, recordedAt: _recordedAt, ...event } = storedEvent
      await store.append(event)
    }
    await store.close()
    const checksumBefore = fileChecksum(ledgerPath)

    const stdout = execFileSync(
      "pnpm",
      [
        "exec",
        "tsx",
        "src/research/research-screening-audit-report-cli.ts",
        "--ledger",
        ledgerPath,
        "--from",
        window.fromSessionDate,
        "--to",
        window.toSessionDate,
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
    )

    expect(JSON.parse(stdout)).toMatchObject({
      reportVersion: "1.0.0",
      cycleCounts: { auditEligible: 18, recordedAudit: 18 },
    })
    expect(fileChecksum(ledgerPath)).toBe(checksumBefore)
  })
})
