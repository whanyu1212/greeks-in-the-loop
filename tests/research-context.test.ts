import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  type LedgerEventV4,
  type StoredLedgerEventV4,
} from "../src/event-ledger/ledger-event-v1.js"
import type { LedgerStore } from "../src/event-ledger/ledger-store.js"
import { createSqliteLedgerStore } from "../src/event-ledger/sqlite-ledger-store.js"
import {
  MAX_RESEARCH_CONTEXT_EVENTS,
  MAX_RESEARCH_CONTEXT_SERIALIZED_BYTES,
  loadResearchContextV1,
  projectResearchContextV1,
  reconstructResearchContextV1,
  researchContextEvidenceKey,
} from "../src/research/context.js"

const temporaryDirectories: string[] = []
const recordedAt = "2026-08-26T14:00:00.000Z"

const stored = (
  event: LedgerEventV4,
  sequence: number,
): StoredLedgerEventV4 => ({ ...event, sequence, recordedAt })

const cycleStarted = (
  cycleNumber: number,
  cycleId = `cycle-${cycleNumber}`,
): LedgerEventV4 => ({
  eventId: `started-${cycleId}`,
  eventVersion: "4.0.0",
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
    | "PORTFOLIO_EVALUATED" = "VALIDATED_NO_ACTION",
): LedgerEventV4 => ({
  eventId: `completed-cycle-${cycleNumber}`,
  eventVersion: "4.0.0",
  eventType: "RESEARCH_CYCLE_COMPLETED",
  occurredAt: `2026-08-26T13:${String(cycleNumber).padStart(2, "0")}:30.000Z`,
  correlationId: `correlation-cycle-${cycleNumber}`,
  causationEventId: `started-cycle-${cycleNumber}`,
  cycleId: `cycle-${cycleNumber}`,
  sessionId: `session-cycle-${cycleNumber}`,
  payload: { status },
})

const validatedProposal = (): LedgerEventV4 => ({
  eventId: "validated-proposal",
  eventVersion: "4.0.0",
  eventType: "RESEARCH_DECISION_VALIDATED",
  occurredAt: "2026-08-26T13:01:10.000Z",
  correlationId: "correlation-cycle-1",
  cycleId: "cycle-1",
  sessionId: "session-cycle-1",
  payload: {
    decision: {
      contractVersion: "3.0.0",
      outcome: "PROPOSE_TRADES",
      proposals: [{
      priority: 1,
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
          snapshotRef: "alpaca-proposal-quotes-v2-SPY",
        },
      ],
      }],
    },
  },
})

const evidenceReferenced = (
  snapshotRef: string,
  cycleId = "cycle-1",
  source = "option-quotes",
): LedgerEventV4 => ({
  eventId: `evidence-${cycleId}-${snapshotRef}`,
  eventVersion: "4.0.0",
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe("ResearchContextV1", () => {
  it("projects normalized bounded memory without decision prose", () => {
    const events: StoredLedgerEventV4[] = [
      stored(cycleStarted(1), 1),
      stored(evidenceReferenced("snapshot-1"), 2),
      stored(validatedProposal(), 3),
      stored(
        {
          eventId: "rejected-1",
          eventVersion: "4.0.0",
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
      stored(cycleCompleted(1, "PORTFOLIO_EVALUATED"), 5),
      stored(cycleStarted(2), 6),
      stored(
        {
          eventId: "validated-no-action",
          eventVersion: "4.0.0",
          eventType: "RESEARCH_DECISION_VALIDATED",
          occurredAt: "2026-08-26T13:02:10.000Z",
          correlationId: "correlation-cycle-2",
          cycleId: "cycle-2",
          payload: {
            decision: {
              contractVersion: "3.0.0",
              outcome: "NO_ACTION",
              reasonCodes: ["SIGNAL_NOT_ACTIONABLE"],
              evidence: [{
                claimId: "mixed-regime",
                kind: "SOURCED_FACT",
                claim: "The retained market regime signal was mixed.",
                provider: "ALPACA",
                temporalClass: "LIVE",
                observedAt: "2026-08-26T13:02:00.000Z",
              }],
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
          eventVersion: "4.0.0",
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
    const events: StoredLedgerEventV4[] = []
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
            eventVersion: "4.0.0",
            eventType: "RESEARCH_CYCLE_INTERRUPTED",
            occurredAt: "2026-08-26T13:02:00.000Z",
            correlationId: `correlation-${cycleId}`,
            cycleId,
            payload: { reason: "PROCESS_RESTART" },
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
    // Largest-first trimming balances the collections instead of starving the
    // small ones: plain round-robin leaves interruption history at its floor
    // of 1 here, because it drops one item per collection per pass regardless
    // of how many each holds.
    expect(Object.keys(context.evidenceReferences).length).toBe(51)
    expect(context.recentInterruptions.length).toBe(52)
    expect(context.requiredRefreshes.length).toBe(52)

    // Newest memory is the memory that survives.
    expect(context.recentInterruptions[0]?.cycleId).toBe("cycle-60")
    expect(context.requiredRefreshes[0]?.cycleId).toBe("cycle-60")

    // Byte-bound trimming dropped history even though the 300 input events fit
    // inside the event window, so the agent must still be told.
    expect(events.length).toBeLessThan(MAX_RESEARCH_CONTEXT_EVENTS)
    expect(context.truncatedBefore).toBe(true)

    // A context that fits keeps reporting complete history.
    expect(
      projectResearchContextV1(events.slice(0, 5), {
        generatedAt: "2026-08-26T14:00:00.000Z",
      }).truncatedBefore,
    ).toBe(false)
  })

  it("enforces event, collection, and final UTF-8 bounds deterministically", () => {
    const events: StoredLedgerEventV4[] = []
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

    expect(context.truncatedBefore).toBe(true)
    expect(serializedBytes).toBeLessThanOrEqual(
      MAX_RESEARCH_CONTEXT_SERIALIZED_BYTES,
    )

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
      cycleCompleted(1),
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
        status: "VALIDATED_NO_ACTION",
      },
    ])
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
    await thirdStore.close()
  })
})
