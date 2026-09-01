import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"

import {
  MAX_LEDGER_EVENT_PAYLOAD_BYTES,
  type LedgerEventV4,
} from "../src/event-ledger/ledger-event-v1.js"
import { loadResearchContextV1 } from "../src/research/context.js"
import {
  createSqliteLedgerStore as createConfiguredSqliteLedgerStore,
  type CreateSqliteLedgerStoreOptions,
} from "../src/event-ledger/deprecated/sqlite-ledger-store.js"

const temporaryDirectories: string[] = []

const createSqliteLedgerStore = (
  options: Omit<CreateSqliteLedgerStoreOptions, "knownCredentialValues">,
) =>
  createConfiguredSqliteLedgerStore({
    ...options,
    knownCredentialValues: [],
  })

const createTemporaryPath = () => {
  const directory = mkdtempSync(join(tmpdir(), "research-ledger-test-"))
  temporaryDirectories.push(directory)
  return join(directory, "ledger.sqlite")
}

const cycleStarted = (
  eventId: string,
  overrides: Partial<LedgerEventV4> = {},
): LedgerEventV4 =>
  ({
    eventId,
    eventVersion: "4.0.0",
    eventType: "RESEARCH_CYCLE_STARTED",
    occurredAt: "2026-08-25T14:30:00.000Z",
    correlationId: "correlation-1",
    cycleId: "cycle-1",
    sessionId: "ses_example",
    payload: {
      cycleNumber: 1,
    },
    ...overrides,
  }) as LedgerEventV4

const cycleCompleted = (
  eventId: string,
  causationEventId: string,
): LedgerEventV4 => ({
  eventId,
  eventVersion: "4.0.0",
  eventType: "RESEARCH_CYCLE_COMPLETED",
  occurredAt: "2026-08-25T14:31:00.000Z",
  correlationId: "correlation-1",
  causationEventId,
  cycleId: "cycle-1",
  sessionId: "ses_example",
  payload: {
    status: "VALIDATED_NO_ACTION",
  },
})

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe("createSqliteLedgerStore", () => {
  it("can refuse to create a missing writable ledger", () => {
    const path = createTemporaryPath()

    expect(() =>
      createSqliteLedgerStore({ path, fileMustExist: true }),
    ).toThrow()
    expect(existsSync(path)).toBe(false)
  })

  it("supports query-only access without changing the ledger", async () => {
    const path = createTemporaryPath()
    const writer = createSqliteLedgerStore({ path })
    await writer.migrate()
    await writer.append(cycleStarted("event-1"))
    await writer.close()
    const before = readFileSync(path)

    const reader = createSqliteLedgerStore({ path, readonly: true })
    await expect(reader.list({ limit: 10 })).resolves.toHaveLength(1)
    await expect(reader.migrate()).rejects.toThrow("Ledger store is read-only")
    await expect(reader.append(cycleStarted("event-2"))).rejects.toThrow(
      "Ledger store is read-only",
    )
    await reader.close()

    expect(readFileSync(path)).toEqual(before)
  })

  it("appends ordered events and reads them by ID", async () => {
    const store = createSqliteLedgerStore({
      path: ":memory:",
      now: () => new Date("2026-08-25T14:32:00.000Z"),
    })
    await store.migrate()

    const append = store.append
    const first = await append(cycleStarted("event-1"))
    const second = await append(cycleCompleted("event-2", "event-1"))

    expect(first.sequence).toBe(1)
    expect(second.sequence).toBe(2)
    expect(first.recordedAt).toBe("2026-08-25T14:32:00.000Z")
    await expect(store.getByEventId("event-2")).resolves.toEqual(second)
    await expect(store.getByEventId("missing")).resolves.toBeUndefined()

    await store.close()
    await store.close()
  })

  it("atomically appends a causally ordered batch", async () => {
    const store = createSqliteLedgerStore({ path: ":memory:" })
    await store.migrate()

    const events = await store.appendBatch([
      cycleStarted("event-1"),
      cycleCompleted("event-2", "event-1"),
    ])

    expect(events.map(({ sequence }) => sequence)).toEqual([1, 2])
    expect(
      (await store.list({ correlationId: "correlation-1", limit: 10 })).map(
        ({ eventId }) => eventId,
      ),
    ).toEqual(["event-1", "event-2"])

    await store.close()
  })

  it("rolls back the entire batch on duplicate or invalid causation", async () => {
    const store = createSqliteLedgerStore({ path: ":memory:" })
    await store.migrate()

    await expect(
      store.appendBatch([
        cycleStarted("duplicate"),
        cycleStarted("duplicate"),
      ]),
    ).rejects.toThrow()
    await expect(store.list({ limit: 10 })).resolves.toEqual([])

    await expect(
      store.appendBatch([
        cycleStarted("event-1"),
        cycleCompleted("event-2", "missing-cause"),
      ]),
    ).rejects.toThrow()
    await expect(store.list({ limit: 10 })).resolves.toEqual([])

    await store.append(cycleStarted("event-existing"))
    await expect(
      store.append(
        {
          ...cycleCompleted("event-cross-correlation", "event-existing"),
          correlationId: "correlation-2",
        },
      ),
    ).rejects.toThrow("cycle identity must match its cycle start")

    await store.close()
  })

  it("fails an unsafe batch before partially committing", async () => {
    const store = createSqliteLedgerStore({ path: ":memory:" })
    await store.migrate()

    const unsafeDecision = {
      eventId: "event-2",
      eventVersion: "4.0.0",
      eventType: "RESEARCH_DECISION_VALIDATED",
      occurredAt: "2026-08-25T14:30:10.000Z",
      correlationId: "correlation-1",
      cycleId: "cycle-1",
      payload: {
        decision: {
          contractVersion: "3.0.0",
          outcome: "NO_ACTION",
          reasonCodes: ["SIGNAL_NOT_ACTIONABLE"],
          evidence: [
            {
              claimId: "fact-1",
              kind: "SOURCED_FACT",
              claim: "Unsafe locator should reject the complete batch.",
              provider: "ALPACA",
              temporalClass: "LIVE",
              observedAt: "2026-08-25T14:30:00.000Z",
              locator: "https://example.com/data?apikey=secret-value",
            },
          ],
        },
      },
    } as LedgerEventV4

    await expect(
      store.appendBatch([
        cycleStarted("event-1"),
        unsafeDecision,
      ]),
    ).rejects.toThrow("Unsafe persistence payload")
    await expect(store.list({ limit: 10 })).resolves.toEqual([])

    await store.close()
  })

  it("rejects secret-bearing fields before schema normalization", async () => {
    const store = createSqliteLedgerStore({ path: ":memory:" })
    await store.migrate()
    const unsafeEvent = {
      ...cycleStarted("event-1"),
      payload: {
        cycleNumber: 1,
        refreshToken: "secret-value",
      },
    } as unknown as LedgerEventV4

    await expect(store.append(unsafeEvent)).rejects.toThrow(
      "Unsafe persistence payload",
    )
    await expect(store.list({ limit: 10 })).resolves.toEqual([])

    await store.close()
  })

  it("rejects bare application credentials in schema-valid text", async () => {
    const credential = "alpaca-bare-credential-123"
    const store = createConfiguredSqliteLedgerStore({
      path: ":memory:",
      knownCredentialValues: [credential],
    })
    await store.migrate()
    const credentialBearingEvent = {
      ...cycleStarted("event-1"),
      eventType: "EVIDENCE_SNAPSHOT_REFERENCED",
      payload: {
        snapshotRef: "snapshot-1",
        provider: "ALPACA",
        source: credential,
        retrievedAt: "2026-08-25T14:30:00.000Z",
        freshUntil: "2026-08-25T14:31:00.000Z",
      },
    } as LedgerEventV4

    await expect(store.append(credentialBearingEvent)).rejects.toThrow(
      "Unsafe persistence payload",
    )
    await expect(store.list({ limit: 10 })).resolves.toEqual([])

    await store.close()
  })

  it("does not expose unknown property names in schema errors", async () => {
    const store = createSqliteLedgerStore({ path: ":memory:" })
    await store.migrate()
    const unsafeProperty = "configured-credential-value"
    const invalidEvent = {
      ...cycleStarted("event-1"),
      [unsafeProperty]: true,
    } as unknown as LedgerEventV4

    let error: unknown
    try {
      await store.append(invalidEvent)
    } catch (caught) {
      error = caught
    }
    expect(String(error)).toBe("Error: Invalid ledger event at batch index 0")
    expect(String(error)).not.toContain(unsafeProperty)

    await store.close()
  })

  it("rejects schema-valid payloads larger than the configured cap", async () => {
    const store = createSqliteLedgerStore({ path: ":memory:" })
    await store.migrate()
    const oversizedEvent = {
      eventId: "event-oversized",
      eventVersion: "4.0.0",
      eventType: "RESEARCH_DECISION_REJECTED",
      occurredAt: "2026-08-25T14:30:10.000Z",
      correlationId: "correlation-1",
      cycleId: "cycle-1",
      payload: {
        issues: Array.from({ length: 64 }, (_, issueIndex) => ({
          code: "SCHEMA_INVALID",
          path: Array.from(
            { length: 32 },
            (_, pathIndex) =>
              `${issueIndex}-${pathIndex}-${"x".repeat(120)}`,
          ),
        })),
      },
    } as LedgerEventV4

    await expect(store.append(oversizedEvent)).rejects.toThrow(
      `Ledger event payload cannot exceed ${MAX_LEDGER_EVENT_PAYLOAD_BYTES} bytes`,
    )
    await expect(store.list({ limit: 10 })).resolves.toEqual([])

    await store.close()
  })

  it("supports bounded parameterized filters and sequence pagination", async () => {
    const store = createSqliteLedgerStore({ path: ":memory:" })
    await store.migrate()
    await store.appendBatch([
      cycleStarted("event-1"),
      cycleCompleted("event-2", "event-1"),
      cycleStarted("event-3", {
        correlationId: "correlation-2",
        cycleId: "cycle-2",
        sessionId: "ses_other",
      }),
    ])

    await expect(
      store.list({
        correlationId: "correlation-1",
        eventTypes: ["RESEARCH_CYCLE_COMPLETED"],
        limit: 10,
      }),
    ).resolves.toMatchObject([{ eventId: "event-2" }])

    await expect(
      store.list({ afterSequence: 1, limit: 1 }),
    ).resolves.toMatchObject([{ eventId: "event-2", sequence: 2 }])

    await expect(
      store.list({ beforeSequence: 3, direction: "DESC", limit: 10 }),
    ).resolves.toMatchObject([
      { eventId: "event-2", sequence: 2 },
      { eventId: "event-1", sequence: 1 },
    ])

    await expect(
      store.list({ afterSequence: 1, beforeSequence: 3, limit: 10 }),
    ).resolves.toMatchObject([{ eventId: "event-2", sequence: 2 }])

    await expect(
      store.list({ sessionId: "ses_other", cycleId: "cycle-2", limit: 10 }),
    ).resolves.toMatchObject([{ eventId: "event-3" }])

    await expect(store.list({ limit: 0 })).rejects.toThrow()
    await expect(store.list({ limit: 1_001 })).rejects.toThrow()
    await expect(
      store.list({ direction: "DROP TABLE ledger_events" as "ASC", limit: 1 }),
    ).rejects.toThrow()

    await store.close()
  })

  it("persists events across file-backed reopen and repeated migration", async () => {
    const path = createTemporaryPath()
    const firstStore = createSqliteLedgerStore({ path })
    await firstStore.migrate()
    await firstStore.append(cycleStarted("event-1"))
    await firstStore.close()

    const secondStore = createSqliteLedgerStore({ path })
    await secondStore.migrate()

    await expect(secondStore.getByEventId("event-1")).resolves.toMatchObject({
      eventId: "event-1",
      sequence: 1,
    })
    await secondStore.close()
  })

  it("decodes historical V1 research reports while loading context", async () => {
    const path = createTemporaryPath()
    const migrated = createSqliteLedgerStore({ path })
    await migrated.migrate()
    await migrated.close()

    const database = new Database(path)
    const insert = database.prepare(`
      INSERT INTO ledger_events (
        event_id, event_version, event_type, occurred_at, recorded_at,
        correlation_id, causation_event_id, cycle_id, session_id, payload_json
      ) VALUES (?, '1.0.0', ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run(
      "legacy-start",
      "RESEARCH_CYCLE_STARTED",
      "2026-08-25T14:30:00.000Z",
      "2026-08-25T14:30:00.000Z",
      "legacy-correlation",
      null,
      "legacy-cycle",
      "legacy-session",
      JSON.stringify({ cycleNumber: 7 }),
    )
    insert.run(
      "legacy-report",
      "RESEARCH_REPORT_RECORDED",
      "2026-08-25T14:31:00.000Z",
      "2026-08-25T14:31:00.000Z",
      "legacy-correlation",
      "legacy-start",
      "legacy-cycle",
      "legacy-session",
      JSON.stringify({ report: { reportVersion: "2.0.0" } }),
    )
    database.close()

    const store = createSqliteLedgerStore({ path, readonly: true })
    await expect(
      loadResearchContextV1(store, {
        generatedAt: "2026-08-25T14:32:00.000Z",
      }),
    ).resolves.toMatchObject({ nextCycleNumber: 8 })
    await expect(
      store.list({ eventTypes: ["RESEARCH_REPORT_RECORDED"], limit: 1 }),
    ).resolves.toMatchObject([
      {
        eventVersion: "1.0.0",
        payload: { report: { reportVersion: "2.0.0" } },
      },
    ])
    await store.close()
  })

  it("rejects direct updates and deletes through durable triggers", async () => {
    const path = createTemporaryPath()
    const store = createSqliteLedgerStore({ path })
    await store.migrate()
    await store.append(cycleStarted("event-1"))
    await store.close()

    const database = new Database(path)
    expect(() =>
      database
        .prepare("UPDATE ledger_events SET correlation_id = ? WHERE event_id = ?")
        .run("changed", "event-1"),
    ).toThrow("ledger events are append-only")
    expect(() =>
      database.prepare("DELETE FROM ledger_events WHERE event_id = ?").run("event-1"),
    ).toThrow("ledger events are append-only")
    database.close()
  })

  it("does not write when already aborted and rejects operations after close", async () => {
    const store = createSqliteLedgerStore({ path: ":memory:" })
    await store.migrate()
    const controller = new AbortController()
    controller.abort()

    await expect(
      store.append(cycleStarted("event-1"), controller.signal),
    ).rejects.toThrow()
    await expect(store.list({ limit: 10 })).resolves.toEqual([])

    await store.close()
    await expect(store.list({ limit: 10 })).rejects.toThrow(
      "Ledger store is closed",
    )
  })
})
