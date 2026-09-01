import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { LedgerEventV4 } from "../src/event-ledger/ledger-event-v1.js"
import { createPostgresLedgerStore } from "../src/event-ledger/postgres-ledger-store.js"
import { acquirePostgresWorkerInstanceLock } from "../src/event-ledger/postgres-worker-instance-lock.js"
import { WorkerInstanceLockUnavailableError } from "../src/event-ledger/worker-instance-lock-errors.js"

const connectionString = process.env.TEST_POSTGRES_URL
const integration = describe.runIf(connectionString !== undefined)

const cycleStarted = (
  cycleId: string,
  eventId = `start-${cycleId}`,
): LedgerEventV4 => ({
  eventId,
  eventVersion: "4.0.0",
  eventType: "RESEARCH_CYCLE_STARTED",
  occurredAt: "2026-09-01T14:00:00.000Z",
  correlationId: `correlation-${cycleId}`,
  cycleId,
  sessionId: `session-${cycleId}`,
  payload: { cycleNumber: 1 },
})

const cycleCompleted = (
  cycleId: string,
  eventId = `completed-${cycleId}`,
): LedgerEventV4 => ({
  eventId,
  eventVersion: "4.0.0",
  eventType: "RESEARCH_CYCLE_COMPLETED",
  occurredAt: "2026-09-01T14:01:00.000Z",
  correlationId: `correlation-${cycleId}`,
  causationEventId: `start-${cycleId}`,
  cycleId,
  sessionId: `session-${cycleId}`,
  payload: { status: "VALIDATED_NO_ACTION" },
})

integration("PostgreSQL ledger integration", () => {
  const poolConfig = { connectionString: connectionString! }
  const administrativePool = new Pool(poolConfig)

  beforeAll(async () => {
    await administrativePool.query("DROP SCHEMA public CASCADE")
    await administrativePool.query("CREATE SCHEMA public")
  })

  afterAll(async () => {
    await administrativePool.end()
  })

  it("migrates idempotently and preserves transactional append semantics", async () => {
    const store = createPostgresLedgerStore({
      poolConfig,
      knownCredentialValues: [],
      now: () => new Date("2026-09-01T14:02:00.000Z"),
    })
    await store.migrate()
    await store.migrate()

    const stored = await store.appendBatch([
      cycleStarted("cycle-1"),
      cycleCompleted("cycle-1"),
    ])
    expect(stored.map(({ sequence }) => sequence)).toEqual([1, 2])
    expect(stored[0]?.recordedAt).toBe("2026-09-01T14:02:00.000Z")
    await expect(store.getByEventId("completed-cycle-1")).resolves.toEqual(
      stored[1],
    )
    await expect(
      store.list({ cycleId: "cycle-1", direction: "DESC", limit: 10 }),
    ).resolves.toMatchObject([
      { eventId: "completed-cycle-1", sequence: 2 },
      { eventId: "start-cycle-1", sequence: 1 },
    ])

    await expect(
      store.appendBatch([
        cycleStarted("cycle-duplicate", "duplicate"),
        cycleStarted("cycle-duplicate", "duplicate"),
      ]),
    ).rejects.toThrow()
    await expect(
      store.list({ cycleId: "cycle-duplicate", limit: 10 }),
    ).resolves.toEqual([])

    await expect(
      store.append({
        ...cycleCompleted("cycle-1", "late-cycle-1"),
        eventType: "RESEARCH_CYCLE_INTERRUPTED",
        payload: { reason: "FAILED" },
      }),
    ).rejects.toThrow("cannot append after a cycle terminal event")

    await store.close()
    await store.close()
  })

  it("enforces append-only storage and distributed worker ownership", async () => {
    await expect(
      administrativePool.query(
        "UPDATE ledger_events SET correlation_id = 'changed' WHERE event_id = 'start-cycle-1'",
      ),
    ).rejects.toThrow("ledger events are append-only")
    await expect(
      administrativePool.query(
        "DELETE FROM ledger_events WHERE event_id = 'start-cycle-1'",
      ),
    ).rejects.toThrow("ledger events are append-only")

    const first = await acquirePostgresWorkerInstanceLock(
      poolConfig,
      "postgres-test-lock",
    )
    await expect(
      acquirePostgresWorkerInstanceLock(poolConfig, "postgres-test-lock"),
    ).rejects.toBeInstanceOf(WorkerInstanceLockUnavailableError)
    await first.release()
    const second = await acquirePostgresWorkerInstanceLock(
      poolConfig,
      "postgres-test-lock",
    )
    await second.release()
  })
})
