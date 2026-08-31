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
  {
    id: "002_research_lifecycle_integrity",
    sql: `
      CREATE TABLE ledger_migration_002_guard (
        valid INTEGER NOT NULL CHECK (valid = 1)
      );

      INSERT INTO ledger_migration_002_guard (valid)
      SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM ledger_events AS event
        WHERE (
          event.event_type <> 'OPENCODE_SESSION_STARTED'
          AND event.cycle_id IS NULL
        ) OR (
          event.cycle_id IS NOT NULL
          AND event.event_type <> 'RESEARCH_CYCLE_STARTED'
          AND NOT EXISTS (
            SELECT 1
            FROM ledger_events AS start
            WHERE start.cycle_id = event.cycle_id
              AND start.event_type = 'RESEARCH_CYCLE_STARTED'
              AND start.correlation_id = event.correlation_id
              AND start.session_id IS event.session_id
          )
        ) OR (
          event.cycle_id IS NOT NULL
          AND event.event_type <> 'RESEARCH_CYCLE_STARTED'
          AND (
            event.causation_event_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM ledger_events AS cause
              WHERE cause.event_id = event.causation_event_id
                AND cause.cycle_id IS event.cycle_id
            )
          )
        ) OR EXISTS (
          SELECT 1
          FROM ledger_events AS terminal
          WHERE terminal.cycle_id = event.cycle_id
            AND terminal.sequence < event.sequence
            AND terminal.event_type IN (
              'RESEARCH_CYCLE_COMPLETED',
              'RESEARCH_CYCLE_INTERRUPTED'
            )
        )
      ) THEN 0 ELSE 1 END;

      DROP TABLE ledger_migration_002_guard;

      CREATE UNIQUE INDEX ledger_events_one_cycle_start
        ON ledger_events(cycle_id)
        WHERE event_type = 'RESEARCH_CYCLE_STARTED';

      CREATE UNIQUE INDEX ledger_events_one_cycle_terminal
        ON ledger_events(cycle_id)
        WHERE event_type IN (
          'RESEARCH_CYCLE_COMPLETED',
          'RESEARCH_CYCLE_INTERRUPTED'
        );

      CREATE TRIGGER ledger_events_cycle_identity
      BEFORE INSERT ON ledger_events
      WHEN NEW.cycle_id IS NOT NULL
        AND NEW.event_type <> 'RESEARCH_CYCLE_STARTED'
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM ledger_events
            WHERE cycle_id = NEW.cycle_id
              AND event_type = 'RESEARCH_CYCLE_STARTED'
          )
          THEN RAISE(ABORT, 'cycle event requires a cycle start')
        END;

        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM ledger_events
            WHERE cycle_id = NEW.cycle_id
              AND event_type = 'RESEARCH_CYCLE_STARTED'
              AND correlation_id = NEW.correlation_id
              AND session_id IS NEW.session_id
          )
          THEN RAISE(ABORT, 'cycle identity must match its cycle start')
        END;
      END;

      CREATE TRIGGER ledger_events_causation_same_cycle
      BEFORE INSERT ON ledger_events
      WHEN NEW.cycle_id IS NOT NULL
        AND NEW.event_type <> 'RESEARCH_CYCLE_STARTED'
        AND EXISTS (
          SELECT 1
          FROM ledger_events
          WHERE cycle_id = NEW.cycle_id
            AND event_type = 'RESEARCH_CYCLE_STARTED'
            AND correlation_id = NEW.correlation_id
            AND session_id IS NEW.session_id
        )
      BEGIN
        SELECT CASE
          WHEN NEW.causation_event_id IS NULL OR NOT EXISTS (
            SELECT 1
            FROM ledger_events
            WHERE event_id = NEW.causation_event_id
              AND cycle_id IS NEW.cycle_id
          )
          THEN RAISE(ABORT, 'causation must reference the same research cycle')
        END;
      END;

      CREATE TRIGGER ledger_events_no_post_terminal
      BEFORE INSERT ON ledger_events
      WHEN NEW.cycle_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM ledger_events
          WHERE cycle_id = NEW.cycle_id
            AND event_type IN (
              'RESEARCH_CYCLE_COMPLETED',
              'RESEARCH_CYCLE_INTERRUPTED'
            )
        )
      BEGIN
        SELECT RAISE(ABORT, 'cannot append after a cycle terminal event');
      END;
    `,
  },
  {
    id: "003_shadow_risk_integrity",
    sql: `
      CREATE UNIQUE INDEX ledger_events_one_shadow_risk_decision
        ON ledger_events(cycle_id)
        WHERE event_type = 'RISK_SHADOW_DECISION_RECORDED';

      CREATE TRIGGER ledger_events_risk_follows_intent
      BEFORE INSERT ON ledger_events
      WHEN NEW.event_type = 'RISK_SHADOW_DECISION_RECORDED'
      BEGIN
        SELECT CASE
          WHEN NEW.cycle_id IS NULL OR NOT EXISTS (
            SELECT 1
            FROM ledger_events
            WHERE event_id = NEW.causation_event_id
              AND cycle_id = NEW.cycle_id
              AND event_type = 'TRADE_INTENT_DERIVED'
          )
          THEN RAISE(ABORT, 'shadow risk decision must follow its trade intent')
        END;
      END;

      CREATE TRIGGER ledger_events_breaker_follows_risk
      BEFORE INSERT ON ledger_events
      WHEN NEW.event_type = 'RISK_BREAKER_LATCHED'
      BEGIN
        SELECT CASE
          WHEN NEW.cycle_id IS NULL OR NOT EXISTS (
            SELECT 1
            FROM ledger_events
            WHERE cycle_id = NEW.cycle_id
              AND event_type = 'RISK_SHADOW_DECISION_RECORDED'
          )
          THEN RAISE(ABORT, 'breaker latch must follow a shadow risk decision')
        END;
      END;

      CREATE TRIGGER ledger_events_intent_completion_requires_risk
      BEFORE INSERT ON ledger_events
      WHEN NEW.event_type = 'RESEARCH_CYCLE_COMPLETED'
        AND json_extract(NEW.payload_json, '$.status') = 'INTENT_DERIVED'
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM ledger_events
            WHERE cycle_id = NEW.cycle_id
              AND event_type = 'RISK_SHADOW_DECISION_RECORDED'
          )
          THEN RAISE(ABORT, 'derived intent completion requires shadow risk')
        END;
      END;
    `,
  },
  {
    id: "004_research_screening_audit",
    sql: `
      DROP TRIGGER ledger_events_no_post_terminal;

      CREATE UNIQUE INDEX ledger_events_one_research_screening_audit
        ON ledger_events(cycle_id)
        WHERE event_type = 'RESEARCH_SCREENING_AUDIT_RECORDED';

      CREATE TRIGGER ledger_events_screening_audit_requires_terminal
      BEFORE INSERT ON ledger_events
      WHEN NEW.event_type = 'RESEARCH_SCREENING_AUDIT_RECORDED'
      BEGIN
        SELECT CASE
          WHEN NEW.cycle_id IS NULL OR NOT EXISTS (
            SELECT 1
            FROM ledger_events
            WHERE event_id = NEW.causation_event_id
              AND cycle_id = NEW.cycle_id
              AND event_type IN (
                'RESEARCH_CYCLE_COMPLETED',
                'RESEARCH_CYCLE_INTERRUPTED'
              )
          )
          THEN RAISE(ABORT, 'screening audit must follow its cycle terminal')
        END;
      END;

      CREATE TRIGGER ledger_events_no_post_terminal
      BEFORE INSERT ON ledger_events
      WHEN NEW.cycle_id IS NOT NULL
        AND NEW.event_type <> 'RESEARCH_SCREENING_AUDIT_RECORDED'
        AND EXISTS (
          SELECT 1
          FROM ledger_events
          WHERE cycle_id = NEW.cycle_id
            AND event_type IN (
              'RESEARCH_CYCLE_COMPLETED',
              'RESEARCH_CYCLE_INTERRUPTED'
            )
        )
      BEGIN
        SELECT RAISE(ABORT, 'cannot append after a cycle terminal event');
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
