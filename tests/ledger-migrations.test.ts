import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"

import {
  applyLedgerMigrations,
  LEDGER_MIGRATIONS,
  type LedgerMigration,
} from "../src/event-ledger/migrations.js"

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
