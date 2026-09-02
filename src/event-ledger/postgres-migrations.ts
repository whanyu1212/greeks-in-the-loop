import { createHash } from "node:crypto"

import type { PoolClient } from "pg"

export type PostgresLedgerMigration = Readonly<{
  id: string
  sql: string
}>

/** Fresh PostgreSQL schema. Existing SQLite ledgers are deliberately not imported. */
export const POSTGRES_LEDGER_MIGRATIONS: readonly PostgresLedgerMigration[] = [
  {
    id: "001_current_ledger_v4",
    sql: `
      CREATE TABLE ledger_events (
        sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        event_version TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        causation_event_id TEXT REFERENCES ledger_events(event_id),
        cycle_id TEXT,
        session_id TEXT,
        payload_json JSONB NOT NULL
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

      CREATE UNIQUE INDEX ledger_events_one_cycle_start
        ON ledger_events(cycle_id)
        WHERE event_type = 'RESEARCH_CYCLE_STARTED';
      CREATE UNIQUE INDEX ledger_events_one_cycle_terminal
        ON ledger_events(cycle_id)
        WHERE event_type IN (
          'RESEARCH_CYCLE_COMPLETED',
          'RESEARCH_CYCLE_INTERRUPTED'
        );
      CREATE UNIQUE INDEX ledger_events_one_shadow_risk_decision
        ON ledger_events(cycle_id)
        WHERE event_type = 'RISK_SHADOW_DECISION_RECORDED';
      CREATE UNIQUE INDEX ledger_events_one_execution_authorization
        ON ledger_events(cycle_id)
        WHERE event_type = 'EXECUTION_AUTHORIZATION_RECORDED';
      CREATE UNIQUE INDEX ledger_events_execution_authorization_id
        ON ledger_events((payload_json #>> '{instruction,authorizationId}'))
        WHERE event_type = 'EXECUTION_AUTHORIZATION_RECORDED';
      CREATE UNIQUE INDEX ledger_events_one_paper_trader_result
        ON ledger_events(cycle_id)
        WHERE event_type = 'PAPER_TRADER_RESULT_RECORDED';

      CREATE FUNCTION ledger_events_validate_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $ledger_insert$
      BEGIN
        IF NEW.cycle_id IS NOT NULL THEN
          PERFORM pg_advisory_xact_lock(
            hashtextextended('greeks-ledger-cycle:' || NEW.cycle_id, 0)
          );
        END IF;

        IF NEW.causation_event_id IS NOT NULL AND NOT EXISTS (
          SELECT 1
          FROM ledger_events
          WHERE event_id = NEW.causation_event_id
            AND correlation_id = NEW.correlation_id
        ) THEN
          RAISE EXCEPTION 'causation must reference the same correlation';
        END IF;

        IF NEW.cycle_id IS NOT NULL
          AND NEW.event_type <> 'RESEARCH_CYCLE_STARTED'
          AND NOT EXISTS (
            SELECT 1
            FROM ledger_events
            WHERE cycle_id = NEW.cycle_id
              AND event_type = 'RESEARCH_CYCLE_STARTED'
          )
        THEN
          RAISE EXCEPTION 'cycle event requires a cycle start';
        END IF;

        IF NEW.cycle_id IS NOT NULL
          AND NEW.event_type <> 'RESEARCH_CYCLE_STARTED'
          AND NOT EXISTS (
            SELECT 1
            FROM ledger_events
            WHERE cycle_id = NEW.cycle_id
              AND event_type = 'RESEARCH_CYCLE_STARTED'
              AND correlation_id = NEW.correlation_id
              AND session_id IS NOT DISTINCT FROM NEW.session_id
          )
        THEN
          RAISE EXCEPTION 'cycle identity must match its cycle start';
        END IF;

        IF NEW.cycle_id IS NOT NULL
          AND NEW.event_type <> 'RESEARCH_CYCLE_STARTED'
          AND (
            NEW.causation_event_id IS NULL OR NOT EXISTS (
              SELECT 1
              FROM ledger_events
              WHERE event_id = NEW.causation_event_id
                AND cycle_id IS NOT DISTINCT FROM NEW.cycle_id
            )
          )
        THEN
          RAISE EXCEPTION 'causation must reference the same research cycle';
        END IF;

        IF NEW.cycle_id IS NOT NULL
          AND NEW.event_type <> 'PAPER_TRADER_RESULT_RECORDED'
          AND EXISTS (
            SELECT 1
            FROM ledger_events
            WHERE cycle_id = NEW.cycle_id
              AND event_type IN (
                'RESEARCH_CYCLE_COMPLETED',
                'RESEARCH_CYCLE_INTERRUPTED'
              )
          )
        THEN
          RAISE EXCEPTION 'cannot append after a cycle terminal event';
        END IF;

        IF NEW.event_type = 'RISK_SHADOW_DECISION_RECORDED'
          AND (
            NEW.cycle_id IS NULL OR NOT EXISTS (
              SELECT 1
              FROM ledger_events
              WHERE event_id = NEW.causation_event_id
                AND cycle_id = NEW.cycle_id
                AND event_type = 'TRADE_INTENT_DERIVED'
            )
          )
        THEN
          RAISE EXCEPTION 'shadow risk decision must follow its trade intent';
        END IF;

        IF NEW.event_type = 'RISK_BREAKER_LATCHED'
          AND (
            NEW.cycle_id IS NULL OR NOT EXISTS (
              SELECT 1
              FROM ledger_events
              WHERE cycle_id = NEW.cycle_id
                AND event_type = 'RISK_SHADOW_DECISION_RECORDED'
            )
          )
        THEN
          RAISE EXCEPTION 'breaker latch must follow a shadow risk decision';
        END IF;

        IF NEW.event_type = 'EXECUTION_AUTHORIZATION_RECORDED'
          AND (
            NEW.cycle_id IS NULL OR NOT EXISTS (
              SELECT 1
              FROM ledger_events
              WHERE event_id = NEW.causation_event_id
                AND cycle_id = NEW.cycle_id
                AND event_type = 'RISK_SHADOW_DECISION_RECORDED'
                AND payload_json #>> '{decision,stage}' = 'EVALUATED'
                AND payload_json #>> '{decision,outcome}' = 'APPROVED'
            )
          )
        THEN
          RAISE EXCEPTION 'execution authorization must follow approved risk';
        END IF;

        IF NEW.event_type = 'PAPER_TRADER_RESULT_RECORDED'
          AND (
            NEW.cycle_id IS NULL OR NOT EXISTS (
              SELECT 1
              FROM ledger_events
              WHERE event_id = NEW.causation_event_id
                AND cycle_id = NEW.cycle_id
                AND event_type = 'EXECUTION_AUTHORIZATION_RECORDED'
            ) OR NOT EXISTS (
              SELECT 1
              FROM ledger_events
              WHERE cycle_id = NEW.cycle_id
                AND event_type = 'RESEARCH_CYCLE_COMPLETED'
            )
          )
        THEN
          RAISE EXCEPTION 'paper trader result must follow completed authorization';
        END IF;

        RETURN NEW;
      END
      $ledger_insert$;

      CREATE TRIGGER ledger_events_validate_insert_trigger
      BEFORE INSERT ON ledger_events
      FOR EACH ROW EXECUTE FUNCTION ledger_events_validate_insert();

      CREATE FUNCTION ledger_events_reject_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $ledger_mutation$
      BEGIN
        RAISE EXCEPTION 'ledger events are append-only';
      END
      $ledger_mutation$;

      CREATE TRIGGER ledger_events_no_update
      BEFORE UPDATE ON ledger_events
      FOR EACH ROW EXECUTE FUNCTION ledger_events_reject_mutation();
      CREATE TRIGGER ledger_events_no_delete
      BEFORE DELETE ON ledger_events
      FOR EACH ROW EXECUTE FUNCTION ledger_events_reject_mutation();
    `,
  },
  {
    id: "002_portfolio_shadow_risk",
    sql: `
      DROP INDEX ledger_events_one_shadow_risk_decision;
      CREATE UNIQUE INDEX ledger_events_one_shadow_risk_decision_per_intent
        ON ledger_events(causation_event_id)
        WHERE event_type = 'RISK_SHADOW_DECISION_RECORDED';
    `,
  },
  {
    id: "003_deterministic_order_execution",
    sql: `
      -- Plan section 5: at most one new approved entry per scheduled cycle.
      CREATE UNIQUE INDEX ledger_events_one_order_submission
        ON ledger_events(cycle_id)
        WHERE event_type = 'ORDER_SUBMITTED';

      CREATE UNIQUE INDEX ledger_events_one_order_terminal
        ON ledger_events(cycle_id)
        WHERE event_type IN ('ORDER_FILLED', 'ORDER_REJECTED');

      CREATE OR REPLACE FUNCTION ledger_events_validate_order_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $ledger_order_insert$
      BEGIN
        -- Plan section 3: the executor consumes only a risk-approved plan, so
        -- an order that skipped the gate is unrepresentable.
        IF NEW.event_type = 'ORDER_SUBMITTED'
          AND (
            NEW.cycle_id IS NULL OR NOT EXISTS (
              SELECT 1
              FROM ledger_events
              WHERE event_id = NEW.causation_event_id
                AND cycle_id = NEW.cycle_id
                AND event_type = 'RISK_SHADOW_DECISION_RECORDED'
                AND payload_json #>> '{decision,stage}' = 'EVALUATED'
                AND payload_json #>> '{decision,outcome}' = 'APPROVED'
            )
          )
        THEN
          RAISE EXCEPTION 'order submission must follow approved risk';
        END IF;

        IF NEW.event_type IN ('ORDER_FILLED', 'ORDER_REJECTED')
          AND (
            NEW.cycle_id IS NULL OR NOT EXISTS (
              SELECT 1
              FROM ledger_events
              WHERE cycle_id = NEW.cycle_id
                AND event_type = 'ORDER_SUBMITTED'
            )
          )
        THEN
          RAISE EXCEPTION 'order terminal must follow its submission';
        END IF;

        RETURN NEW;
      END
      $ledger_order_insert$;

      CREATE TRIGGER ledger_events_validate_order_insert_trigger
      BEFORE INSERT ON ledger_events
      FOR EACH ROW EXECUTE FUNCTION ledger_events_validate_order_insert();

      -- Deterministic execution runs after the cycle terminal, so order events
      -- join the paper-trader result as the kinds allowed to land afterwards.
      CREATE OR REPLACE FUNCTION ledger_events_validate_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $ledger_insert$
      BEGIN
        IF NEW.causation_event_id IS NOT NULL
          AND NEW.causation_event_id = NEW.event_id
        THEN
          RAISE EXCEPTION 'an event cannot cause itself';
        END IF;

        IF NEW.cycle_id IS NOT NULL
          AND NEW.event_type <> 'RESEARCH_CYCLE_STARTED'
          AND NOT EXISTS (
            SELECT 1
            FROM ledger_events
            WHERE cycle_id = NEW.cycle_id
              AND event_type = 'RESEARCH_CYCLE_STARTED'
              AND correlation_id = NEW.correlation_id
              AND session_id IS NOT DISTINCT FROM NEW.session_id
          )
        THEN
          RAISE EXCEPTION 'cycle identity must match its cycle start';
        END IF;

        IF NEW.cycle_id IS NOT NULL
          AND NEW.event_type <> 'RESEARCH_CYCLE_STARTED'
          AND (
            NEW.causation_event_id IS NULL OR NOT EXISTS (
              SELECT 1
              FROM ledger_events
              WHERE event_id = NEW.causation_event_id
                AND cycle_id IS NOT DISTINCT FROM NEW.cycle_id
            )
          )
        THEN
          RAISE EXCEPTION 'causation must reference the same research cycle';
        END IF;

        IF NEW.cycle_id IS NOT NULL
          AND NEW.event_type NOT IN (
            'PAPER_TRADER_RESULT_RECORDED',
            'ORDER_SUBMITTED',
            'ORDER_FILLED',
            'ORDER_REJECTED'
          )
          AND EXISTS (
            SELECT 1
            FROM ledger_events
            WHERE cycle_id = NEW.cycle_id
              AND event_type IN (
                'RESEARCH_CYCLE_COMPLETED',
                'RESEARCH_CYCLE_INTERRUPTED'
              )
          )
        THEN
          RAISE EXCEPTION 'cannot append after a cycle terminal event';
        END IF;

        IF NEW.event_type = 'RISK_SHADOW_DECISION_RECORDED'
          AND (
            NEW.cycle_id IS NULL OR NOT EXISTS (
              SELECT 1
              FROM ledger_events
              WHERE event_id = NEW.causation_event_id
                AND cycle_id = NEW.cycle_id
                AND event_type = 'TRADE_INTENT_DERIVED'
            )
          )
        THEN
          RAISE EXCEPTION 'shadow risk decision must follow its trade intent';
        END IF;

        IF NEW.event_type = 'RISK_BREAKER_LATCHED'
          AND (
            NEW.cycle_id IS NULL OR NOT EXISTS (
              SELECT 1
              FROM ledger_events
              WHERE cycle_id = NEW.cycle_id
                AND event_type = 'RISK_SHADOW_DECISION_RECORDED'
            )
          )
        THEN
          RAISE EXCEPTION 'breaker latch must follow a shadow risk decision';
        END IF;

        IF NEW.event_type = 'EXECUTION_AUTHORIZATION_RECORDED'
          AND (
            NEW.cycle_id IS NULL OR NOT EXISTS (
              SELECT 1
              FROM ledger_events
              WHERE event_id = NEW.causation_event_id
                AND cycle_id = NEW.cycle_id
                AND event_type = 'RISK_SHADOW_DECISION_RECORDED'
                AND payload_json #>> '{decision,stage}' = 'EVALUATED'
                AND payload_json #>> '{decision,outcome}' = 'APPROVED'
            )
          )
        THEN
          RAISE EXCEPTION 'execution authorization must follow approved risk';
        END IF;

        IF NEW.event_type = 'PAPER_TRADER_RESULT_RECORDED'
          AND (
            NEW.cycle_id IS NULL OR NOT EXISTS (
              SELECT 1
              FROM ledger_events
              WHERE event_id = NEW.causation_event_id
                AND cycle_id = NEW.cycle_id
                AND event_type = 'EXECUTION_AUTHORIZATION_RECORDED'
            ) OR NOT EXISTS (
              SELECT 1
              FROM ledger_events
              WHERE cycle_id = NEW.cycle_id
                AND event_type = 'RESEARCH_CYCLE_COMPLETED'
            )
          )
        THEN
          RAISE EXCEPTION 'paper trader result must follow completed authorization';
        END IF;

        RETURN NEW;
      END
      $ledger_insert$;
    `,
  },
  {
    id: "004_exact_order_terminal_causation",
    sql: `
      CREATE OR REPLACE FUNCTION ledger_events_validate_order_terminal_identity()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $ledger_order_terminal_identity$
      BEGIN
        IF NEW.event_type IN ('ORDER_FILLED', 'ORDER_REJECTED')
          AND (
            NEW.cycle_id IS NULL OR NOT EXISTS (
              SELECT 1
              FROM ledger_events
              WHERE event_id = NEW.causation_event_id
                AND cycle_id = NEW.cycle_id
                AND event_type = 'ORDER_SUBMITTED'
                AND payload_json ->> 'clientOrderId' =
                  NEW.payload_json ->> 'clientOrderId'
            )
          )
        THEN
          RAISE EXCEPTION 'order terminal must match its submission';
        END IF;

        RETURN NEW;
      END
      $ledger_order_terminal_identity$;

      CREATE TRIGGER ledger_events_validate_order_terminal_identity_trigger
      BEFORE INSERT ON ledger_events
      FOR EACH ROW EXECUTE FUNCTION ledger_events_validate_order_terminal_identity();
    `,
  },
  {
    id: "005_restore_cycle_advisory_lock",
    sql: `
      -- Trigger names run alphabetically for the same timing/event. Acquire the
      -- cycle lock before any trigger performs state-dependent validation.
      CREATE FUNCTION ledger_events_lock_cycle_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $ledger_cycle_lock$
      BEGIN
        IF NEW.cycle_id IS NOT NULL THEN
          PERFORM pg_advisory_xact_lock(
            hashtextextended('greeks-ledger-cycle:' || NEW.cycle_id, 0)
          );
        END IF;

        RETURN NEW;
      END
      $ledger_cycle_lock$;

      CREATE TRIGGER ledger_events_00_lock_cycle_insert
      BEFORE INSERT ON ledger_events
      FOR EACH ROW EXECUTE FUNCTION ledger_events_lock_cycle_insert();
    `,
  },
]

const checksum = (sql: string) =>
  createHash("sha256").update(sql, "utf8").digest("hex")

/** Applies the fresh PostgreSQL schema under a database-wide migration lock. */
export async function applyPostgresLedgerMigrations(
  client: PoolClient,
  migrations: readonly PostgresLedgerMigration[] = POSTGRES_LEDGER_MIGRATIONS,
  recordedAt: () => string = () => new Date().toISOString(),
): Promise<void> {
  const migrationIds = migrations.map(({ id }) => id)
  if (
    new Set(migrationIds).size !== migrationIds.length ||
    migrationIds.some((id, index) => index > 0 && id <= migrationIds[index - 1]!)
  ) {
    throw new Error("PostgreSQL ledger migrations must have unique ascending identifiers")
  }

  await client.query("BEGIN")
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('greeks-ledger-migrations', 0))",
    )
    await client.query(`
      CREATE TABLE IF NOT EXISTS ledger_migrations (
        migration_id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `)
    const existing = await client.query<{
      migration_id: string
      checksum: string
    }>(
      "SELECT migration_id, checksum FROM ledger_migrations ORDER BY migration_id ASC",
    )
    const applied = new Map(
      existing.rows.map((row) => [row.migration_id, row.checksum]),
    )
    const configuredIds = new Set(migrationIds)
    const unknownMigration = existing.rows.find(
      ({ migration_id }) => !configuredIds.has(migration_id),
    )
    if (unknownMigration !== undefined) {
      throw new Error(
        `Unknown applied PostgreSQL ledger migration: ${unknownMigration.migration_id}`,
      )
    }

    let pendingMigrationSeen = false
    for (const migrationId of migrationIds) {
      if (!applied.has(migrationId)) pendingMigrationSeen = true
      else if (pendingMigrationSeen) {
        throw new Error("Applied PostgreSQL ledger migrations do not form a valid prefix")
      }
    }

    for (const migration of migrations) {
      const expectedChecksum = checksum(migration.sql)
      const appliedChecksum = applied.get(migration.id)
      if (appliedChecksum !== undefined) {
        if (appliedChecksum !== expectedChecksum) {
          throw new Error(
            `PostgreSQL migration checksum mismatch: ${migration.id}`,
          )
        }
        continue
      }
      await client.query(migration.sql)
      await client.query(
        `INSERT INTO ledger_migrations (migration_id, checksum, applied_at)
         VALUES ($1, $2, $3)`,
        [migration.id, expectedChecksum, recordedAt()],
      )
    }
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  }
}
