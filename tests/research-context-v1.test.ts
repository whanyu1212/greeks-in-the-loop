import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type {
  LedgerEventV1,
  StoredLedgerEventV1,
} from "../src/event-ledger/ledger-event-v1.js"
import { createSqliteLedgerStore } from "../src/event-ledger/sqlite-ledger-store.js"
import {
  MAX_RESEARCH_CONTEXT_EVENTS,
  MAX_RESEARCH_CONTEXT_SERIALIZED_BYTES,
  loadResearchContextV1,
  projectResearchContextV1,
  reconstructResearchContextV1,
  researchContextEvidenceKey,
} from "../src/research/research-context-v1.js"

const temporaryDirectories: string[] = []
const recordedAt = "2026-08-26T14:00:00.000Z"

const stored = (
  event: LedgerEventV1,
  sequence: number,
): StoredLedgerEventV1 => ({ ...event, sequence, recordedAt })

const cycleStarted = (
  cycleNumber: number,
  cycleId = `cycle-${cycleNumber}`,
): LedgerEventV1 => ({
  eventId: `started-${cycleId}`,
  eventVersion: "1.0.0",
  eventType: "RESEARCH_CYCLE_STARTED",
  occurredAt: `2026-08-26T13:${String(cycleNumber).padStart(2, "0")}:00.000Z`,
  correlationId: `correlation-${cycleId}`,
  cycleId,
  sessionId: `session-${cycleId}`,
  payload: { cycleNumber },
})

const cycleCompleted = (
  cycleNumber: number,
  status:
    | "VALIDATED_NO_ACTION"
    | "PRELIMINARY_RESEARCH_RETAINED"
    | "INTENT_DERIVED" = "VALIDATED_NO_ACTION",
): LedgerEventV1 => ({
  eventId: `completed-cycle-${cycleNumber}`,
  eventVersion: "1.0.0",
  eventType: "RESEARCH_CYCLE_COMPLETED",
  occurredAt: `2026-08-26T13:${String(cycleNumber).padStart(2, "0")}:30.000Z`,
  correlationId: `correlation-cycle-${cycleNumber}`,
  causationEventId: `started-cycle-${cycleNumber}`,
  cycleId: `cycle-${cycleNumber}`,
  sessionId: `session-cycle-${cycleNumber}`,
  payload: { status },
})

const validatedProposal = (): LedgerEventV1 => ({
  eventId: "validated-proposal",
  eventVersion: "1.0.0",
  eventType: "RESEARCH_DECISION_VALIDATED",
  occurredAt: "2026-08-26T13:01:10.000Z",
  correlationId: "correlation-cycle-1",
  cycleId: "cycle-1",
  sessionId: "session-cycle-1",
  payload: {
    decision: {
      contractVersion: "1.0.0",
      strategyVersion: "1.1.0",
      outcome: "PROPOSE_TRADE",
      direction: "BULLISH",
      thesis: "PROSE_THESIS_MUST_NOT_SURVIVE",
      candidate: {
        underlying: "SPY",
        structure: "BULL_CALL_SPREAD",
        expiration: "2026-09-18",
        longLeg: { contractSymbol: "SPY260918C00600000", strike: 600 },
        shortLeg: { contractSymbol: "SPY260918C00605000", strike: 605 },
      },
      invalidation: ["PROSE_INVALIDATION_MUST_NOT_SURVIVE"],
      evidence: [
        {
          claimId: "claim-1",
          kind: "SOURCED_FACT",
          claim: "PROSE_EVIDENCE_CLAIM_MUST_NOT_SURVIVE",
          snapshotRef: "snapshot-1",
        },
      ],
    },
  },
})

const evidenceReferenced = (
  snapshotRef: string,
  cycleId = "cycle-1",
  source = "option-quotes",
): LedgerEventV1 => ({
  eventId: `evidence-${cycleId}-${snapshotRef}`,
  eventVersion: "1.0.0",
  eventType: "EVIDENCE_SNAPSHOT_REFERENCED",
  occurredAt: "2026-08-26T13:01:05.000Z",
  correlationId: `correlation-${cycleId}`,
  cycleId,
  payload: {
    snapshotRef,
    provider: "ALPACA",
    source,
    retrievedAt: "2026-08-26T13:01:00.000Z",
    freshUntil: "2026-08-26T13:02:00.000Z",
  },
})

const preliminaryRecorded = (): LedgerEventV1 => ({
  eventId: "preliminary-cycle-1",
  eventVersion: "1.0.0",
  eventType: "PRELIMINARY_RESEARCH_RECORDED",
  occurredAt: "2026-08-26T13:01:10.000Z",
  correlationId: "correlation-cycle-1",
  causationEventId: "started-cycle-1",
  cycleId: "cycle-1",
  sessionId: "session-cycle-1",
  payload: {
    research: {
      contractVersion: "1.0.0",
      strategyVersion: "1.1.0",
      outcome: "PRELIMINARY_RESEARCH",
      targetSessionDate: "2026-08-26",
      direction: "UNDETERMINED",
      thesis: "Refresh the prior-close setup during the regular session.",
      invalidation: ["Reject if live evidence is unavailable."],
      evidence: [
        {
          claimId: "prior-close",
          kind: "SOURCED_FACT",
          claim: "The latest completed daily bar is from the prior close.",
          provider: "ALPACA",
          temporalClass: "PRIOR_CLOSE",
          observedAt: "2026-08-25T20:00:00.000Z",
        },
      ],
      requiresRefresh: true,
    },
  },
})

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe("ResearchContextV1", () => {
  it("carries the latest preliminary finding forward with mandatory refresh", () => {
    const context = projectResearchContextV1(
      [
        stored(cycleStarted(1), 1),
        stored(preliminaryRecorded(), 2),
        stored(cycleCompleted(1, "PRELIMINARY_RESEARCH_RETAINED"), 3),
      ],
      { generatedAt: "2026-08-26T14:00:00.000Z" },
    )

    expect(context.latestPreliminaryResearch).toMatchObject({
      cycleId: "cycle-1",
      targetSessionDate: "2026-08-26",
      direction: "UNDETERMINED",
      sourcedObservations: [
        {
          claimId: "prior-close",
          provider: "ALPACA",
          temporalClass: "PRIOR_CLOSE",
          observedAt: "2026-08-25T20:00:00.000Z",
        },
      ],
      requiresRefresh: true,
    })
    expect(JSON.stringify(context)).not.toContain("Refresh the prior-close setup")
    expect(JSON.stringify(context)).not.toContain("latest completed daily bar")
    expect(context.requiredRefreshes).toContainEqual({
      cycleId: "cycle-1",
      reason: "PRELIMINARY_RESEARCH",
    })
  })

  it("clears preliminary refresh after a later proposal is freshly validated", () => {
    const laterProposal: LedgerEventV1 = {
      ...validatedProposal(),
      eventId: "validated-proposal-cycle-2",
      correlationId: "correlation-cycle-2",
      cycleId: "cycle-2",
      sessionId: "session-cycle-2",
    }
    const context = projectResearchContextV1(
      [
        stored(cycleStarted(1), 1),
        stored(preliminaryRecorded(), 2),
        stored(cycleCompleted(1, "PRELIMINARY_RESEARCH_RETAINED"), 3),
        stored(cycleStarted(2), 4),
        stored(laterProposal, 5),
        stored(cycleCompleted(2, "INTENT_DERIVED"), 6),
      ],
      { generatedAt: "2026-08-26T14:00:00.000Z" },
    )

    expect(context.latestPreliminaryResearch).toBeUndefined()
    expect(context.requiredRefreshes).not.toContainEqual({
      cycleId: "cycle-1",
      reason: "PRELIMINARY_RESEARCH",
    })
  })

  it("projects normalized bounded memory without decision prose", () => {
    const events: StoredLedgerEventV1[] = [
      stored(cycleStarted(1), 1),
      stored(evidenceReferenced("snapshot-1"), 2),
      stored(validatedProposal(), 3),
      stored(
        {
          eventId: "rejected-1",
          eventVersion: "1.0.0",
          eventType: "RESEARCH_DECISION_REJECTED",
          occurredAt: "2026-08-26T13:01:20.000Z",
          correlationId: "correlation-cycle-1",
          cycleId: "cycle-1",
          payload: {
            issues: [
              { code: "SCHEMA_INVALID", path: ["thesis"] },
              { code: "SCHEMA_INVALID", path: ["evidence", 0] },
            ],
          },
        },
        4,
      ),
      stored(cycleCompleted(1, "INTENT_DERIVED"), 5),
      stored(cycleStarted(2), 6),
      stored(
        {
          eventId: "validated-no-action",
          eventVersion: "1.0.0",
          eventType: "RESEARCH_DECISION_VALIDATED",
          occurredAt: "2026-08-26T13:02:10.000Z",
          correlationId: "correlation-cycle-2",
          cycleId: "cycle-2",
          payload: {
            decision: {
              contractVersion: "1.0.0",
              strategyVersion: "1.1.0",
              outcome: "NO_ACTION",
              reasonCodes: ["SIGNAL_NOT_ACTIONABLE"],
              evidence: [],
            },
          },
        },
        7,
      ),
      stored(cycleCompleted(2), 8),
      stored(cycleStarted(3), 9),
      stored(
        {
          eventId: "interrupted-cycle-3",
          eventVersion: "1.0.0",
          eventType: "RESEARCH_CYCLE_INTERRUPTED",
          occurredAt: "2026-08-26T13:03:20.000Z",
          correlationId: "correlation-cycle-3",
          causationEventId: "started-cycle-3",
          cycleId: "cycle-3",
          sessionId: "session-cycle-3",
          payload: { reason: "TIMEOUT" },
        },
        10,
      ),
    ]

    const context = projectResearchContextV1(events, {
      generatedAt: "2026-08-26T14:00:00.000Z",
    })

    expect(context.nextCycleNumber).toBe(4)
    expect(context.latestValidatedProposal).toEqual({
      cycleId: "cycle-1",
      direction: "BULLISH",
      underlying: "SPY",
      structure: "BULL_CALL_SPREAD",
      expiration: "2026-09-18",
      longContractSymbol: "SPY260918C00600000",
      shortContractSymbol: "SPY260918C00605000",
    })
    expect(context.recentTerminalOutcomes.map(({ cycleId }) => cycleId)).toEqual([
      "cycle-2",
      "cycle-1",
    ])
    expect(context.recurringRejectionCounts).toEqual([
      {
        code: "SCHEMA_INVALID",
        count: 2,
        sources: ["DECISION_VALIDATION"],
      },
      {
        code: "SIGNAL_NOT_ACTIONABLE",
        count: 1,
        sources: ["NO_ACTION"],
      },
    ])
    expect(
      context.evidenceReferences[
        researchContextEvidenceKey("cycle-1", "snapshot-1")
      ],
    ).toMatchObject({ cycleId: "cycle-1", snapshotRef: "snapshot-1" })
    expect(context.recentInterruptions).toMatchObject([
      { cycleId: "cycle-3", cycleNumber: 3, reason: "TIMEOUT" },
    ])
    expect(context.requiredRefreshes).toEqual(
      expect.arrayContaining([
        {
          cycleId: "cycle-1",
          snapshotRef: "snapshot-1",
          reason: "STALE_EVIDENCE",
        },
        { cycleId: "cycle-3", reason: "INTERRUPTED_CYCLE" },
      ]),
    )

    const serialized = JSON.stringify(context)
    expect(serialized).not.toContain("PROSE_THESIS_MUST_NOT_SURVIVE")
    expect(serialized).not.toContain("PROSE_INVALIDATION_MUST_NOT_SURVIVE")
    expect(serialized).not.toContain("PROSE_EVIDENCE_CLAIM_MUST_NOT_SURVIVE")
    expect(serialized).not.toContain('"path"')
  })

  it("distributes retained memory across collections at the byte boundary", () => {
    // Characterization test: pins which memory survives when the projection is
    // over its serialized budget. The byte cap alone does not say *which*
    // collection loses items, so these counts are the contract a reshape of the
    // trim policy has to justify changing.
    const events: StoredLedgerEventV1[] = []
    let sequence = 1
    for (let cycle = 1; cycle <= 60; cycle += 1) {
      const cycleId = `cycle-${cycle}`
      events.push(stored(cycleStarted(cycle, cycleId), sequence))
      sequence += 1
      for (let index = 0; index < 3; index += 1) {
        events.push(
          stored(
            evidenceReferenced(
              `snapshot-${cycle}-${index}-${"s".repeat(50)}`,
              cycleId,
              "o".repeat(120),
            ),
            sequence,
          ),
        )
        sequence += 1
      }
      events.push(
        stored(
          {
            eventId: `interrupted-${cycleId}`,
            eventVersion: "1.0.0",
            eventType: "RESEARCH_CYCLE_INTERRUPTED",
            occurredAt: "2026-08-26T13:02:00.000Z",
            correlationId: `correlation-${cycleId}`,
            cycleId,
            payload: { reason: "PROCESS_EXIT" },
          },
          sequence,
        ),
      )
      sequence += 1
    }

    const context = projectResearchContextV1(events, {
      generatedAt: "2026-08-26T14:00:00.000Z",
    })

    expect(
      Buffer.byteLength(JSON.stringify(context), "utf8"),
    ).toBeLessThanOrEqual(MAX_RESEARCH_CONTEXT_SERIALIZED_BYTES)
    expect(Object.keys(context.evidenceReferences).length).toBe(59)
    expect(context.recentInterruptions.length).toBe(12)
    expect(context.requiredRefreshes.length).toBe(59)

    // Newest memory is the memory that survives.
    expect(context.recentInterruptions[0]?.cycleId).toBe("cycle-60")
    expect(context.requiredRefreshes[0]?.cycleId).toBe("cycle-60")
  })

  it("enforces event, collection, and final UTF-8 bounds deterministically", () => {
    const events: StoredLedgerEventV1[] = []
    for (let index = 1; index <= 700; index += 1) {
      events.push(stored(cycleStarted(index), index * 2 - 1))
      events.push(stored(cycleCompleted(index), index * 2))
    }
    for (let index = 0; index < 100; index += 1) {
      const snapshotRef = `snapshot-${String(index).padStart(3, "0")}-${"s".repeat(100)}`
      events.push(
        stored(
          evidenceReferenced(snapshotRef, "cycle-700", "x".repeat(128)),
          1_401 + index,
        ),
      )
    }

    const context = projectResearchContextV1(events, {
      generatedAt: "2026-08-26T14:00:00.000Z",
    })
    const serializedBytes = Buffer.byteLength(JSON.stringify(context), "utf8")

    expect(context.window.eventCount).toBe(MAX_RESEARCH_CONTEXT_EVENTS)
    expect(context.window.truncatedBefore).toBe(true)
    expect(context.recentTerminalOutcomes.length).toBeLessThanOrEqual(24)
    expect(serializedBytes).toBeLessThanOrEqual(
      MAX_RESEARCH_CONTEXT_SERIALIZED_BYTES,
    )
    expect(context.serializedUtf8Bytes).toBe(serializedBytes)
    expect(context.truncation.evidenceReferencesOmitted).toBeGreaterThan(0)

    expect(
      projectResearchContextV1([...events].reverse(), {
        generatedAt: "2026-08-26T14:00:00.000Z",
      }),
    ).toEqual(context)
  })

  it("recovers incomplete cycles across reopen and remains idempotent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "research-context-test-"))
    temporaryDirectories.push(directory)
    const path = join(directory, "ledger.sqlite")
    const createStore = () =>
      createSqliteLedgerStore({ path, knownCredentialValues: [] })

    const firstStore = createStore()
    await firstStore.migrate()
    await firstStore.appendBatch([
      cycleStarted(1),
      preliminaryRecorded(),
      cycleCompleted(1, "PRELIMINARY_RESEARCH_RETAINED"),
      cycleStarted(2),
    ])
    await firstStore.close()

    const secondStore = createStore()
    await secondStore.migrate()
    let generatedIds = 0
    const context = await reconstructResearchContextV1(secondStore, {
      createEventId: (start) => {
        generatedIds += 1
        return `restart-${start.eventId}`
      },
      now: () => new Date("2026-08-26T14:00:00.000Z"),
    })

    expect(generatedIds).toBe(1)
    expect(context.nextCycleNumber).toBe(3)
    expect(context.recentTerminalOutcomes).toMatchObject([
      {
        cycleId: "cycle-1",
        cycleNumber: 1,
        status: "PRELIMINARY_RESEARCH_RETAINED",
      },
    ])
    expect(context.latestPreliminaryResearch).toMatchObject({
      cycleId: "cycle-1",
      targetSessionDate: "2026-08-26",
      requiresRefresh: true,
    })
    expect(context.recentInterruptions).toMatchObject([
      {
        cycleId: "cycle-2",
        cycleNumber: 2,
        reason: "PROCESS_RESTART",
      },
    ])

    await reconstructResearchContextV1(secondStore, {
      createEventId: () => {
        generatedIds += 1
        return "unexpected-second-recovery"
      },
      now: () => new Date("2026-08-26T14:01:00.000Z"),
    })
    expect(generatedIds).toBe(1)
    await expect(
      secondStore.list({
        eventTypes: ["RESEARCH_CYCLE_INTERRUPTED"],
        limit: 10,
      }),
    ).resolves.toMatchObject([
      {
        eventId: "restart-started-cycle-2",
        correlationId: "correlation-cycle-2",
        causationEventId: "started-cycle-2",
        cycleId: "cycle-2",
        sessionId: "session-cycle-2",
        payload: { reason: "PROCESS_RESTART" },
      },
    ])
    await secondStore.close()

    const thirdStore = createStore()
    await thirdStore.migrate()
    const reopenedContext = await loadResearchContextV1(thirdStore, {
      generatedAt: "2026-08-26T14:02:00.000Z",
    })
    expect(reopenedContext.recentInterruptions).toMatchObject([
      { cycleId: "cycle-2", reason: "PROCESS_RESTART" },
    ])
    expect(reopenedContext.latestPreliminaryResearch).toMatchObject({
      cycleId: "cycle-1",
      direction: "UNDETERMINED",
      requiresRefresh: true,
    })
    await thirdStore.close()
  })
})
