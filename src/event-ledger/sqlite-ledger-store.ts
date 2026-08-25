import Database from "better-sqlite3"
import { z } from "zod"

import {
  ledgerEventV1Schema,
  LEDGER_EVENT_TYPES,
  type LedgerEventV1,
  type StoredLedgerEventV1,
} from "./ledger-event-v1.js"
import type {
  LedgerEventQuery,
  LedgerStore,
} from "./ledger-store.js"
import { applyLedgerMigrations } from "./migrations.js"
import { assertPersistenceSafe } from "./persistence-safety.js"

export const MAX_LEDGER_EVENT_PAYLOAD_BYTES = 64 * 1024

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const querySchema = z
  .object({
    afterSequence: z.number().int().nonnegative().optional(),
    correlationId: identifier.optional(),
    cycleId: identifier.optional(),
    sessionId: identifier.optional(),
    eventTypes: z
      .array(z.enum(LEDGER_EVENT_TYPES))
      .min(1)
      .max(32)
      .optional(),
    limit: z.number().int().positive().max(1_000),
  })
  .strict()

type LedgerRow = {
  sequence: number
  event_id: string
  event_version: string
  event_type: string
  occurred_at: string
  recorded_at: string
  correlation_id: string
  causation_event_id: string | null
  cycle_id: string | null
  session_id: string | null
  payload_json: string
}

const INSERT_EVENT_SQL = `
  INSERT INTO ledger_events (
    event_id,
    event_version,
    event_type,
    occurred_at,
    recorded_at,
    correlation_id,
    causation_event_id,
    cycle_id,
    session_id,
    payload_json
  ) VALUES (
    @eventId,
    @eventVersion,
    @eventType,
    @occurredAt,
    @recordedAt,
    @correlationId,
    @causationEventId,
    @cycleId,
    @sessionId,
    @payloadJson
  )
`

const SELECT_COLUMNS = `
  sequence,
  event_id,
  event_version,
  event_type,
  occurred_at,
  recorded_at,
  correlation_id,
  causation_event_id,
  cycle_id,
  session_id,
  payload_json
`

const decodeRow = (row: LedgerRow): StoredLedgerEventV1 => {
  const parsed = ledgerEventV1Schema.parse({
    eventId: row.event_id,
    eventVersion: row.event_version,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
    ...(row.causation_event_id === null
      ? {}
      : { causationEventId: row.causation_event_id }),
    ...(row.cycle_id === null ? {} : { cycleId: row.cycle_id }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    payload: JSON.parse(row.payload_json) as unknown,
  })

  return {
    ...parsed,
    sequence: row.sequence,
    recordedAt: z.iso
      .datetime({ offset: true, precision: 3 })
      .parse(row.recorded_at),
  }
}

const toInsertParameters = (
  event: LedgerEventV1,
  recordedAt: string,
) => ({
  eventId: event.eventId,
  eventVersion: event.eventVersion,
  eventType: event.eventType,
  occurredAt: event.occurredAt,
  recordedAt,
  correlationId: event.correlationId,
  causationEventId: event.causationEventId ?? null,
  cycleId: event.cycleId ?? null,
  sessionId: event.sessionId ?? null,
  payloadJson: JSON.stringify(event.payload),
})

export type CreateSqliteLedgerStoreOptions = Readonly<{
  path: string
  now?: () => Date
  timeoutMs?: number
}>

/**
 * Creates the single-writer SQLite implementation of the research ledger.
 *
 * Call `migrate` before append or query operations. The adapter owns the
 * connection and serializes all writes through immediate transactions.
 */
export function createSqliteLedgerStore({
  path,
  now = () => new Date(),
  timeoutMs = 5_000,
}: CreateSqliteLedgerStoreOptions): LedgerStore {
  const database = new Database(path, { timeout: timeoutMs })
  database.pragma("foreign_keys = ON")
  database.pragma("journal_mode = WAL")
  database.pragma("synchronous = FULL")
  database.pragma(`busy_timeout = ${timeoutMs}`)

  let closed = false

  const assertOpen = () => {
    if (closed || !database.open) throw new Error("Ledger store is closed")
  }

  const appendValidated = (
    events: readonly LedgerEventV1[],
    recordedAt: string,
  ): StoredLedgerEventV1[] => {
    const insert = database.prepare(INSERT_EVENT_SQL)
    const getById = database.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM ledger_events
      WHERE event_id = ?
    `)

    const appendTransaction = database.transaction(() =>
      events.map((event) => {
        insert.run(toInsertParameters(event, recordedAt))
        const row = getById.get(event.eventId) as LedgerRow | undefined
        if (row === undefined) throw new Error("Appended ledger event was not found")
        return decodeRow(row)
      }),
    )

    return appendTransaction.immediate()
  }

  const appendBatch = async (
    events: readonly LedgerEventV1[],
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted()
    assertOpen()
    if (events.length === 0) return []
    if (events.length > 1_000) {
      throw new Error("Ledger append batch cannot exceed 1000 events")
    }

    assertPersistenceSafe(events)
    const validated = events.map((event) => ledgerEventV1Schema.parse(event))
    assertPersistenceSafe(validated)
    for (const event of validated) {
      if (
        Buffer.byteLength(JSON.stringify(event.payload), "utf8") >
        MAX_LEDGER_EVENT_PAYLOAD_BYTES
      ) {
        throw new Error(
          `Ledger event payload cannot exceed ${MAX_LEDGER_EVENT_PAYLOAD_BYTES} bytes`,
        )
      }
    }
    signal?.throwIfAborted()

    const recordedAt = now().toISOString()
    return appendValidated(validated, recordedAt)
  }

  return {
    async migrate(signal) {
      signal?.throwIfAborted()
      assertOpen()
      applyLedgerMigrations(database, undefined, () => now().toISOString())
    },

    async append(event, signal) {
      const [stored] = await appendBatch([event], signal)
      if (stored === undefined) throw new Error("Ledger append returned no event")
      return stored
    },

    appendBatch,

    async getByEventId(eventId) {
      assertOpen()
      const validEventId = identifier.parse(eventId)
      const row = database
        .prepare(`
          SELECT ${SELECT_COLUMNS}
          FROM ledger_events
          WHERE event_id = ?
        `)
        .get(validEventId) as LedgerRow | undefined
      return row === undefined ? undefined : decodeRow(row)
    },

    async list(query: LedgerEventQuery) {
      assertOpen()
      const parsed = querySchema.parse(query)
      const where: string[] = ["sequence > @afterSequence"]
      const parameters: Record<string, string | number> = {
        afterSequence: parsed.afterSequence ?? 0,
        limit: parsed.limit,
      }

      for (const [field, column] of [
        ["correlationId", "correlation_id"],
        ["cycleId", "cycle_id"],
        ["sessionId", "session_id"],
      ] as const) {
        const value = parsed[field]
        if (value === undefined) continue
        where.push(`${column} = @${field}`)
        parameters[field] = value
      }

      if (parsed.eventTypes !== undefined) {
        const placeholders = parsed.eventTypes.map((eventType, index) => {
          const name = `eventType${index}`
          parameters[name] = eventType
          return `@${name}`
        })
        where.push(`event_type IN (${placeholders.join(", ")})`)
      }

      const rows = database
        .prepare(`
          SELECT ${SELECT_COLUMNS}
          FROM ledger_events
          WHERE ${where.join(" AND ")}
          ORDER BY sequence ASC
          LIMIT @limit
        `)
        .all(parameters) as LedgerRow[]

      return rows.map(decodeRow)
    },

    async close() {
      if (closed) return
      closed = true
      if (database.open) database.close()
    },
  }
}
