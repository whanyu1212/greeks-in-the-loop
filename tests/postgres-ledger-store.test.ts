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

  it("enforces exact order approval and terminal causation in PostgreSQL", async () => {
    type RawEvent = Readonly<{
      eventId: string
      eventType: string
      cycleId: string
      causationEventId?: string
      payload?: unknown
    }>
    const appendRaw = ({
      eventId,
      eventType,
      cycleId,
      causationEventId,
      payload = {},
    }: RawEvent) =>
      administrativePool.query(
        `INSERT INTO ledger_events (
           event_id, event_version, event_type, occurred_at, recorded_at,
           correlation_id, causation_event_id, cycle_id, session_id, payload_json
         ) VALUES ($1, '4.0.0', $2, $3, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          eventId,
          eventType,
          "2026-09-01T14:03:00.000Z",
          `correlation-${cycleId}`,
          causationEventId ?? null,
          cycleId,
          `session-${cycleId}`,
          JSON.stringify(payload),
        ],
      )

    await appendRaw({
      eventId: "start-order-rejected",
      eventType: "RESEARCH_CYCLE_STARTED",
      cycleId: "order-rejected",
    })
    await appendRaw({
      eventId: "intent-order-rejected",
      eventType: "TRADE_INTENT_DERIVED",
      cycleId: "order-rejected",
      causationEventId: "start-order-rejected",
    })
    await appendRaw({
      eventId: "risk-order-rejected",
      eventType: "RISK_SHADOW_DECISION_RECORDED",
      cycleId: "order-rejected",
      causationEventId: "intent-order-rejected",
      payload: { decision: { stage: "EVALUATED", outcome: "REJECTED" } },
    })
    await expect(
      appendRaw({
        eventId: "submission-order-rejected",
        eventType: "ORDER_SUBMITTED",
        cycleId: "order-rejected",
        causationEventId: "risk-order-rejected",
        payload: { clientOrderId: "order-rejected" },
      }),
    ).rejects.toThrow("order submission must follow approved risk")

    await appendRaw({
      eventId: "start-order-approved",
      eventType: "RESEARCH_CYCLE_STARTED",
      cycleId: "order-approved",
    })
    await appendRaw({
      eventId: "intent-order-approved",
      eventType: "TRADE_INTENT_DERIVED",
      cycleId: "order-approved",
      causationEventId: "start-order-approved",
    })
    await appendRaw({
      eventId: "risk-order-approved",
      eventType: "RISK_SHADOW_DECISION_RECORDED",
      cycleId: "order-approved",
      causationEventId: "intent-order-approved",
      payload: { decision: { stage: "EVALUATED", outcome: "APPROVED" } },
    })
    await appendRaw({
      eventId: "submission-order-approved",
      eventType: "ORDER_SUBMITTED",
      cycleId: "order-approved",
      causationEventId: "risk-order-approved",
      payload: { clientOrderId: "order-approved" },
    })
    await expect(
      appendRaw({
        eventId: "submission-order-approved-duplicate",
        eventType: "ORDER_SUBMITTED",
        cycleId: "order-approved",
        causationEventId: "risk-order-approved",
        payload: { clientOrderId: "order-approved" },
      }),
    ).rejects.toThrow()
    await expect(
      appendRaw({
        eventId: "fill-order-approved-wrong-cause",
        eventType: "ORDER_FILLED",
        cycleId: "order-approved",
        causationEventId: "risk-order-approved",
        payload: { clientOrderId: "order-approved" },
      }),
    ).rejects.toThrow("order terminal must match its submission")
    await expect(
      appendRaw({
        eventId: "fill-order-approved-wrong-client",
        eventType: "ORDER_FILLED",
        cycleId: "order-approved",
        causationEventId: "submission-order-approved",
        payload: { clientOrderId: "different-client" },
      }),
    ).rejects.toThrow("order terminal must match its submission")
    await expect(
      appendRaw({
        eventId: "fill-order-approved",
        eventType: "ORDER_FILLED",
        cycleId: "order-approved",
        causationEventId: "submission-order-approved",
        payload: { clientOrderId: "order-approved" },
      }),
    ).resolves.toBeDefined()
  })
})
