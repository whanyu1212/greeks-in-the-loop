import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"

import {
  applyLedgerMigrations,
  LEDGER_MIGRATIONS,
  type LedgerMigration,
} from "../src/event-ledger/deprecated/migrations.js"

type DirectEvent = Readonly<{
  eventId: string
  eventType: string
  correlationId?: string
  causationEventId?: string
  cycleId?: string
  sessionId?: string
  payload?: unknown
}>

const insertDirectEvent = (
  database: Database.Database,
  {
    eventId,
    eventType,
    correlationId = "correlation-1",
    causationEventId,
    cycleId,
    sessionId = "session-1",
    payload = {},
  }: DirectEvent,
) =>
  database
    .prepare(`
      INSERT INTO ledger_events (
        event_id, event_version, event_type, occurred_at, recorded_at,
        correlation_id, causation_event_id, cycle_id, session_id, payload_json
      ) VALUES (?, '1.0.0', ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      eventId,
      eventType,
      "2026-08-25T14:30:00.000Z",
      "2026-08-25T14:30:00.000Z",
      correlationId,
      causationEventId ?? null,
      cycleId ?? null,
      sessionId,
      JSON.stringify(payload),
    )

describe("applyLedgerMigrations", () => {
  it("applies the current schema idempotently", () => {
    const database = new Database(":memory:")

    applyLedgerMigrations(database, LEDGER_MIGRATIONS, () =>
      "2026-08-25T14:30:00.000Z",
    )
    applyLedgerMigrations(database, LEDGER_MIGRATIONS, () =>
      "2026-08-25T14:31:00.000Z",
    )

    const migrations = database
      .prepare("SELECT migration_id, applied_at FROM ledger_migrations")
      .all()
    expect(migrations).toEqual([
      {
        migration_id: "001_initial_ledger",
        applied_at: "2026-08-25T14:30:00.000Z",
      },
      {
        migration_id: "002_research_lifecycle_integrity",
        applied_at: "2026-08-25T14:30:00.000Z",
      },
      {
        migration_id: "003_shadow_risk_integrity",
        applied_at: "2026-08-25T14:30:00.000Z",
      },
      {
        migration_id: "004_research_screening_audit",
        applied_at: "2026-08-25T14:30:00.000Z",
      },
      {
        migration_id: "005_remove_research_screening_audit",
        applied_at: "2026-08-25T14:30:00.000Z",
      },
      {
        migration_id: "006_paper_execution_authorization",
        applied_at: "2026-08-25T14:30:00.000Z",
      },
      {
        migration_id: "007_portfolio_shadow_risk",
        applied_at: "2026-08-25T14:30:00.000Z",
      },
      {
        migration_id: "008_deterministic_order_execution",
        applied_at: "2026-08-25T14:30:00.000Z",
      },
    ])
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_events'",
        )
        .get(),
    ).toEqual({ name: "ledger_events" })

    database.close()
  })

  it("rejects checksum changes for an applied migration", () => {
    const database = new Database(":memory:")
    applyLedgerMigrations(database, LEDGER_MIGRATIONS)

    const modified = [
      {
        ...LEDGER_MIGRATIONS[0]!,
        sql: `${LEDGER_MIGRATIONS[0]!.sql}\nSELECT 1;`,
      },
      ...LEDGER_MIGRATIONS.slice(1),
    ]

    expect(() => applyLedgerMigrations(database, modified)).toThrow(
      "Migration checksum mismatch: 001_initial_ledger",
    )
    database.close()
  })

  it("rejects applied migrations unknown to the running code", () => {
    const database = new Database(":memory:")
    applyLedgerMigrations(database)
    database
      .prepare("INSERT INTO ledger_migrations VALUES (?, ?, ?)")
      .run("999_unknown", "unverifiable", "2026-08-25T14:30:00.000Z")

    expect(() => applyLedgerMigrations(database)).toThrow(
      "Unknown applied ledger migration: 999_unknown",
    )
    database.close()
  })

  it("rejects applied migrations that do not form a prefix", () => {
    const database = new Database(":memory:")
    applyLedgerMigrations(database, [])
    database
      .prepare("INSERT INTO ledger_migrations VALUES (?, ?, ?)")
      .run("002_second", "unverifiable", "2026-08-25T14:30:00.000Z")

    expect(() =>
      applyLedgerMigrations(database, [
        { id: "001_first", sql: "SELECT 1;" },
        { id: "002_second", sql: "SELECT 1;" },
      ]),
    ).toThrow("Applied ledger migrations do not form a valid prefix")
    database.close()
  })

  it("rolls back a failed migration without recording it", () => {
    const database = new Database(":memory:")
    const migrations: readonly LedgerMigration[] = [
      {
        id: "001_failure",
        sql: `
          CREATE TABLE should_rollback (id INTEGER PRIMARY KEY);
          INSERT INTO missing_table (id) VALUES (1);
        `,
      },
    ]

    expect(() => applyLedgerMigrations(database, migrations)).toThrow()
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'",
        )
        .get(),
    ).toBeUndefined()
    expect(
      database.prepare("SELECT COUNT(*) FROM ledger_migrations").pluck().get(),
    ).toBe(0)

    database.close()
  })

  it("rejects duplicate or out-of-order migration identifiers", () => {
    const database = new Database(":memory:")

    expect(() =>
      applyLedgerMigrations(database, [
        { id: "002_second", sql: "SELECT 1;" },
        { id: "001_first", sql: "SELECT 1;" },
      ]),
    ).toThrow("Ledger migrations must have unique ascending identifiers")

    expect(() =>
      applyLedgerMigrations(database, [
        { id: "001_same", sql: "SELECT 1;" },
        { id: "001_same", sql: "SELECT 2;" },
      ]),
    ).toThrow("Ledger migrations must have unique ascending identifiers")

    database.close()
  })
})

describe("research lifecycle integrity migration", () => {
  it("installs partial uniqueness for one start and one terminal per cycle", () => {
    const database = new Database(":memory:")
    applyLedgerMigrations(database)

    const indexes = database
      .prepare(`
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'ledger_events_one_cycle_start',
            'ledger_events_one_cycle_terminal'
          )
        ORDER BY name
      `)
      .all() as { name: string; sql: string }[]
    expect(indexes).toHaveLength(2)
    expect(indexes.every(({ sql }) => sql.includes("WHERE event_type"))).toBe(true)

    insertDirectEvent(database, {
      eventId: "start-1",
      eventType: "RESEARCH_CYCLE_STARTED",
      cycleId: "cycle-1",
    })
    expect(() =>
      insertDirectEvent(database, {
        eventId: "start-2",
        eventType: "RESEARCH_CYCLE_STARTED",
        cycleId: "cycle-1",
      }),
    ).toThrow("UNIQUE constraint failed: ledger_events.cycle_id")

    insertDirectEvent(database, {
      eventId: "terminal-1",
      eventType: "RESEARCH_CYCLE_COMPLETED",
      causationEventId: "start-1",
      cycleId: "cycle-1",
    })
    expect(() =>
      insertDirectEvent(database, {
        eventId: "terminal-2",
        eventType: "RESEARCH_CYCLE_INTERRUPTED",
        causationEventId: "start-1",
        cycleId: "cycle-1",
      }),
    ).toThrow("cannot append after a cycle terminal event")

    database.close()
  })

  it("rejects missing starts and correlation or session identity drift", () => {
    const database = new Database(":memory:")
    applyLedgerMigrations(database)

    expect(() =>
      insertDirectEvent(database, {
        eventId: "orphan",
        eventType: "RESEARCH_DECISION_REJECTED",
        cycleId: "cycle-missing",
      }),
    ).toThrow("cycle event requires a cycle start")

    insertDirectEvent(database, {
      eventId: "start-1",
      eventType: "RESEARCH_CYCLE_STARTED",
      cycleId: "cycle-1",
    })
    expect(() =>
      insertDirectEvent(database, {
        eventId: "drift-correlation",
        eventType: "RESEARCH_DECISION_REJECTED",
        correlationId: "correlation-2",
        cycleId: "cycle-1",
      }),
    ).toThrow("cycle identity must match its cycle start")
    expect(() =>
      insertDirectEvent(database, {
        eventId: "drift-session",
        eventType: "RESEARCH_DECISION_REJECTED",
        cycleId: "cycle-1",
        sessionId: "session-2",
      }),
    ).toThrow("cycle identity must match its cycle start")

    database.close()
  })

  it("rejects cross-cycle causation even within one correlation", () => {
    const database = new Database(":memory:")
    applyLedgerMigrations(database)

    for (const cycleId of ["cycle-1", "cycle-2"]) {
      insertDirectEvent(database, {
        eventId: `start-${cycleId}`,
        eventType: "RESEARCH_CYCLE_STARTED",
        cycleId,
      })
    }
    insertDirectEvent(database, {
      eventId: "cycle-1-evidence",
      eventType: "EVIDENCE_SNAPSHOT_REFERENCED",
      causationEventId: "start-cycle-1",
      cycleId: "cycle-1",
    })

    expect(() =>
      insertDirectEvent(database, {
        eventId: "cycle-2-decision",
        eventType: "RESEARCH_DECISION_VALIDATED",
        causationEventId: "cycle-1-evidence",
        cycleId: "cycle-2",
      }),
    ).toThrow("causation must reference the same research cycle")

    insertDirectEvent(database, {
      eventId: "session-parent",
      eventType: "OPENCODE_SESSION_STARTED",
      correlationId: "correlation-1",
    })
    expect(() =>
      insertDirectEvent(database, {
        eventId: "cycle-2-session-cause",
        eventType: "RESEARCH_DECISION_VALIDATED",
        causationEventId: "session-parent",
        cycleId: "cycle-2",
      }),
    ).toThrow("causation must reference the same research cycle")

    database.close()
  })

  it("rejects every event appended after completion or interruption", () => {
    const database = new Database(":memory:")
    applyLedgerMigrations(database)

    for (const [cycleId, terminalType] of [
      ["cycle-completed", "RESEARCH_CYCLE_COMPLETED"],
      ["cycle-interrupted", "RESEARCH_CYCLE_INTERRUPTED"],
    ] as const) {
      const startId = `start-${cycleId}`
      insertDirectEvent(database, {
        eventId: startId,
        eventType: "RESEARCH_CYCLE_STARTED",
        cycleId,
      })
      insertDirectEvent(database, {
        eventId: `terminal-${cycleId}`,
        eventType: terminalType,
        causationEventId: startId,
        cycleId,
      })
      expect(() =>
        insertDirectEvent(database, {
          eventId: `late-${cycleId}`,
          eventType: "EVIDENCE_SNAPSHOT_REFERENCED",
          causationEventId: startId,
          cycleId,
        }),
      ).toThrow("cannot append after a cycle terminal event")
    }

    database.close()
  })

  it("refuses to certify invalid history when upgrading a populated v1 ledger", () => {
    const invalidHistories: readonly ((database: Database.Database) => void)[] = [
      (database) => {
        insertDirectEvent(database, {
          eventId: "orphan",
          eventType: "RESEARCH_DECISION_REJECTED",
          cycleId: "cycle-orphan",
        })
      },
      (database) => {
        insertDirectEvent(database, {
          eventId: "start-drift",
          eventType: "RESEARCH_CYCLE_STARTED",
          cycleId: "cycle-drift",
        })
        insertDirectEvent(database, {
          eventId: "event-drift",
          eventType: "RESEARCH_DECISION_REJECTED",
          correlationId: "correlation-2",
          cycleId: "cycle-drift",
        })
      },
      (database) => {
        insertDirectEvent(database, {
          eventId: "start-cross-1",
          eventType: "RESEARCH_CYCLE_STARTED",
          cycleId: "cycle-cross-1",
        })
        insertDirectEvent(database, {
          eventId: "start-cross-2",
          eventType: "RESEARCH_CYCLE_STARTED",
          cycleId: "cycle-cross-2",
        })
        insertDirectEvent(database, {
          eventId: "event-cross",
          eventType: "RESEARCH_DECISION_REJECTED",
          causationEventId: "start-cross-1",
          cycleId: "cycle-cross-2",
        })
      },
      (database) => {
        insertDirectEvent(database, {
          eventId: "start-late",
          eventType: "RESEARCH_CYCLE_STARTED",
          cycleId: "cycle-late",
        })
        insertDirectEvent(database, {
          eventId: "terminal-late",
          eventType: "RESEARCH_CYCLE_COMPLETED",
          causationEventId: "start-late",
          cycleId: "cycle-late",
        })
        insertDirectEvent(database, {
          eventId: "event-late",
          eventType: "RESEARCH_DECISION_REJECTED",
          causationEventId: "terminal-late",
          cycleId: "cycle-late",
        })
      },
    ]

    for (const populate of invalidHistories) {
      const database = new Database(":memory:")
      applyLedgerMigrations(database, LEDGER_MIGRATIONS.slice(0, 1))
      populate(database)

      expect(() => applyLedgerMigrations(database)).toThrow(
        "CHECK constraint failed: valid = 1",
      )
      expect(
        database
          .prepare("SELECT migration_id FROM ledger_migrations ORDER BY migration_id")
          .pluck()
          .all(),
      ).toEqual(["001_initial_ledger"])
      database.close()
    }
  })
})

describe("shadow risk integrity migration", () => {
  it("allows one shadow decision per trade intent in a portfolio cycle", () => {
    const database = new Database(":memory:")
    applyLedgerMigrations(database)
    insertDirectEvent(database, {
      eventId: "start-risk",
      eventType: "RESEARCH_CYCLE_STARTED",
      cycleId: "cycle-risk",
    })
    insertDirectEvent(database, {
      eventId: "intent-risk",
      eventType: "TRADE_INTENT_DERIVED",
      causationEventId: "start-risk",
      cycleId: "cycle-risk",
    })

    expect(() =>
      insertDirectEvent(database, {
        eventId: "completion-without-risk",
        eventType: "RESEARCH_CYCLE_COMPLETED",
        causationEventId: "intent-risk",
        cycleId: "cycle-risk",
        payload: { status: "INTENT_DERIVED" },
      }),
    ).toThrow("derived intent completion requires shadow risk")

    insertDirectEvent(database, {
      eventId: "risk-decision",
      eventType: "RISK_SHADOW_DECISION_RECORDED",
      causationEventId: "intent-risk",
      cycleId: "cycle-risk",
    })
    expect(() =>
      insertDirectEvent(database, {
        eventId: "risk-decision-duplicate",
        eventType: "RISK_SHADOW_DECISION_RECORDED",
        causationEventId: "intent-risk",
        cycleId: "cycle-risk",
      }),
    ).toThrow("UNIQUE constraint failed: ledger_events.causation_event_id")
    insertDirectEvent(database, {
      eventId: "intent-risk-2",
      eventType: "TRADE_INTENT_DERIVED",
      causationEventId: "risk-decision",
      cycleId: "cycle-risk",
    })
    insertDirectEvent(database, {
      eventId: "risk-decision-2",
      eventType: "RISK_SHADOW_DECISION_RECORDED",
      causationEventId: "intent-risk-2",
      cycleId: "cycle-risk",
    })
    insertDirectEvent(database, {
      eventId: "completion-with-risk",
      eventType: "RESEARCH_CYCLE_COMPLETED",
      causationEventId: "risk-decision-2",
      cycleId: "cycle-risk",
      payload: { status: "INTENT_DERIVED" },
    })
    database.close()
  })

  it("allows legacy completed intents when upgrading an existing ledger", () => {
    const database = new Database(":memory:")
    applyLedgerMigrations(database, LEDGER_MIGRATIONS.slice(0, 2))
    insertDirectEvent(database, {
      eventId: "legacy-start",
      eventType: "RESEARCH_CYCLE_STARTED",
      cycleId: "legacy-cycle",
    })
    insertDirectEvent(database, {
      eventId: "legacy-intent",
      eventType: "TRADE_INTENT_DERIVED",
      causationEventId: "legacy-start",
      cycleId: "legacy-cycle",
    })
    insertDirectEvent(database, {
      eventId: "legacy-completion",
      eventType: "RESEARCH_CYCLE_COMPLETED",
      causationEventId: "legacy-intent",
      cycleId: "legacy-cycle",
      payload: { status: "INTENT_DERIVED" },
    })

    expect(() => applyLedgerMigrations(database)).not.toThrow()
    database.close()
  })
})
