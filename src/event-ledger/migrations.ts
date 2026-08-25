import { createHash } from "node:crypto"

import type Database from "better-sqlite3"

export type LedgerMigration = Readonly<{
  id: string
  sql: string
}>

export const LEDGER_MIGRATIONS: readonly LedgerMigration[] = [
  {
    id: "001_initial_ledger",
    sql: `
      CREATE TABLE ledger_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        event_version TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        causation_event_id TEXT,
        cycle_id TEXT,
        session_id TEXT,
        payload_json TEXT NOT NULL,
        FOREIGN KEY (causation_event_id) REFERENCES ledger_events(event_id)
      );

      CREATE INDEX ledger_events_correlation_sequence
        ON ledger_events(correlation_id, sequence);
      CREATE INDEX ledger_events_cycle_sequence
        ON ledger_events(cycle_id, sequence);
      CREATE INDEX ledger_events_session_sequence
        ON ledger_events(session_id, sequence);
      CREATE INDEX ledger_events_type_sequence
        ON ledger_events(event_type, sequence);
      CREATE INDEX ledger_events_occurred_at
        ON ledger_events(occurred_at);

      CREATE TRIGGER ledger_events_causation_same_correlation
      BEFORE INSERT ON ledger_events
      WHEN NEW.causation_event_id IS NOT NULL
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM ledger_events
            WHERE event_id = NEW.causation_event_id
              AND correlation_id = NEW.correlation_id
          )
          THEN RAISE(ABORT, 'causation must reference the same correlation')
        END;
      END;

      CREATE TRIGGER ledger_events_no_update
      BEFORE UPDATE ON ledger_events
      BEGIN
        SELECT RAISE(ABORT, 'ledger events are append-only');
      END;

      CREATE TRIGGER ledger_events_no_delete
      BEFORE DELETE ON ledger_events
      BEGIN
        SELECT RAISE(ABORT, 'ledger events are append-only');
      END;
    `,
  },
]

const checksum = (sql: string) =>
  createHash("sha256").update(sql, "utf8").digest("hex")

export function applyLedgerMigrations(
  database: Database.Database,
  migrations: readonly LedgerMigration[] = LEDGER_MIGRATIONS,
  recordedAt: () => string = () => new Date().toISOString(),
): void {
  const migrationIds = migrations.map(({ id }) => id)
  if (
    new Set(migrationIds).size !== migrationIds.length ||
    migrationIds.some((id, index) => index > 0 && id <= migrationIds[index - 1]!)
  ) {
    throw new Error("Ledger migrations must have unique ascending identifiers")
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS ledger_migrations (
      migration_id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)

  const existing = database
    .prepare(
      "SELECT migration_id, checksum FROM ledger_migrations ORDER BY migration_id ASC",
    )
    .all() as { migration_id: string; checksum: string }[]
  const applied = new Map(existing.map((row) => [row.migration_id, row.checksum]))
  const configuredIds = new Set(migrationIds)
  const unknownMigration = existing.find(
    ({ migration_id }) => !configuredIds.has(migration_id),
  )
  if (unknownMigration !== undefined) {
    throw new Error(
      `Unknown applied ledger migration: ${unknownMigration.migration_id}`,
    )
  }

  let pendingMigrationSeen = false
  for (const migrationId of migrationIds) {
    if (!applied.has(migrationId)) {
      pendingMigrationSeen = true
    } else if (pendingMigrationSeen) {
      throw new Error("Applied ledger migrations do not form a valid prefix")
    }
  }

  const insert = database.prepare(`
    INSERT INTO ledger_migrations (migration_id, checksum, applied_at)
    VALUES (?, ?, ?)
  `)

  const run = database.transaction(() => {
    for (const migration of migrations) {
      const expectedChecksum = checksum(migration.sql)
      const appliedChecksum = applied.get(migration.id)
      if (appliedChecksum !== undefined) {
        if (appliedChecksum !== expectedChecksum) {
          throw new Error(`Migration checksum mismatch: ${migration.id}`)
        }
        continue
      }

      database.exec(migration.sql)
      insert.run(migration.id, expectedChecksum, recordedAt())
    }
  })

  run.immediate()
}
