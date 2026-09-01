import { Pool, type PoolConfig } from "pg"
import { z } from "zod"

import {
  ledgerEventSchema,
  ledgerEventV4Schema,
  LEDGER_EVENT_VERSION,
  MAX_LEDGER_EVENT_PAYLOAD_BYTES,
  STORED_LEDGER_EVENT_TYPES,
  type LedgerEventV4,
  type StoredLedgerEvent,
  type StoredLedgerEventV4,
} from "./ledger-event-v1.js"
import type { LedgerEventQuery, LedgerStore } from "./ledger-store.js"
import { applyPostgresLedgerMigrations } from "./postgres-migrations.js"
import { assertPersistenceSafe } from "./persistence-safety.js"

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const querySchema = z
  .object({
    afterSequence: z.number().int().nonnegative().optional(),
    beforeSequence: z.number().int().nonnegative().optional(),
    direction: z.enum(["ASC", "DESC"]).optional(),
    correlationId: identifier.optional(),
    cycleId: identifier.optional(),
    sessionId: identifier.optional(),
    eventTypes: z
      .array(z.enum(STORED_LEDGER_EVENT_TYPES))
      .min(1)
      .max(32)
      .optional(),
    limit: z.number().int().positive().max(1_000),
  })
  .strict()

type PostgresLedgerRow = {
  sequence: string | number
  event_id: string
  event_version: string
  event_type: string
  occurred_at: string
  recorded_at: string
  correlation_id: string
  causation_event_id: string | null
  cycle_id: string | null
  session_id: string | null
  payload_json: unknown
}

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

const decodeRow = (row: PostgresLedgerRow): StoredLedgerEvent => {
  const sequence = Number(row.sequence)
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error("PostgreSQL ledger sequence is invalid")
  }
  const payload = typeof row.payload_json === "string"
    ? JSON.parse(row.payload_json) as unknown
    : row.payload_json
  const parsed = ledgerEventSchema.parse({
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
    payload,
  })
  return {
    ...parsed,
    sequence,
    recordedAt: z.iso
      .datetime({ offset: true, precision: 3 })
      .parse(row.recorded_at),
  }
}

const validatedEvents = (
  events: readonly LedgerEventV4[],
  protectedCredentialValues: readonly string[],
) => {
  if (events.length > 1_000) {
    throw new Error("Ledger append batch cannot exceed 1000 events")
  }
  assertPersistenceSafe(events, protectedCredentialValues)
  const validated = events.map((event, index) => {
    const parsed = ledgerEventV4Schema.safeParse(event)
    if (!parsed.success) {
      throw new Error(`Invalid ledger event at batch index ${index}`)
    }
    return parsed.data
  })
  assertPersistenceSafe(validated, protectedCredentialValues)
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
  return validated
}

export type CreatePostgresLedgerStoreOptions = Readonly<{
  poolConfig: PoolConfig
  knownCredentialValues: readonly string[]
  now?: () => Date
  readonly?: boolean
}>

/** Creates the Cloud SQL/PostgreSQL implementation of the append-only ledger. */
export function createPostgresLedgerStore({
  poolConfig,
  knownCredentialValues,
  now = () => new Date(),
  readonly = false,
}: CreatePostgresLedgerStoreOptions): LedgerStore {
  if (
    !Array.isArray(knownCredentialValues) ||
    knownCredentialValues.length > 32 ||
    knownCredentialValues.some(
      (credential) =>
        typeof credential !== "string" ||
        credential.length === 0 ||
        credential.length > 4_096,
    )
  ) {
    throw new Error("Known credential values are invalid")
  }
  const protectedCredentialValues = [...knownCredentialValues]
  const pool = new Pool({
    max: 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: true,
    application_name: "greeks-in-the-loop",
    ...poolConfig,
  })
  let closed = false

  const assertOpen = () => {
    if (closed) throw new Error("Ledger store is closed")
  }
  const assertWritable = () => {
    if (readonly) throw new Error("Ledger store is read-only")
  }

  const appendBatch = async (
    events: readonly LedgerEventV4[],
    signal?: AbortSignal,
  ): Promise<readonly StoredLedgerEventV4[]> => {
    signal?.throwIfAborted()
    assertOpen()
    assertWritable()
    if (events.length === 0) return []
    const validated = validatedEvents(events, protectedCredentialValues)
    signal?.throwIfAborted()
    const recordedAt = now().toISOString()
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const stored: StoredLedgerEventV4[] = []
      for (const event of validated) {
        signal?.throwIfAborted()
        const result = await client.query<PostgresLedgerRow>(
          `INSERT INTO ledger_events (
             event_id, event_version, event_type, occurred_at, recorded_at,
             correlation_id, causation_event_id, cycle_id, session_id, payload_json
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
           RETURNING ${SELECT_COLUMNS}`,
          [
            event.eventId,
            event.eventVersion,
            event.eventType,
            event.occurredAt,
            recordedAt,
            event.correlationId,
            event.causationEventId ?? null,
            event.cycleId ?? null,
            event.sessionId ?? null,
            JSON.stringify(event.payload),
          ],
        )
        const row = result.rows[0]
        if (row === undefined) throw new Error("Appended ledger event was not found")
        const decoded = decodeRow(row)
        if (decoded.eventVersion !== LEDGER_EVENT_VERSION) {
          throw new Error("Appended ledger event has an unexpected version")
        }
        stored.push(decoded)
      }
      signal?.throwIfAborted()
      await client.query("COMMIT")
      return stored
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  return {
    async migrate(signal) {
      signal?.throwIfAborted()
      assertOpen()
      assertWritable()
      const client = await pool.connect()
      try {
        await applyPostgresLedgerMigrations(client, undefined, () =>
          now().toISOString(),
        )
      } finally {
        client.release()
      }
      signal?.throwIfAborted()
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
      const result = await pool.query<PostgresLedgerRow>(
        `SELECT ${SELECT_COLUMNS}
         FROM ledger_events
         WHERE event_id = $1`,
        [validEventId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : decodeRow(row)
    },

    async list(query: LedgerEventQuery) {
      assertOpen()
      const parsed = querySchema.parse(query)
      const values: unknown[] = [parsed.afterSequence ?? 0]
      const where = ["sequence > $1"]
      const add = (condition: (position: number) => string, value: unknown) => {
        values.push(value)
        where.push(condition(values.length))
      }
      if (parsed.beforeSequence !== undefined) {
        add((position) => `sequence < $${position}`, parsed.beforeSequence)
      }
      for (const [field, column] of [
        ["correlationId", "correlation_id"],
        ["cycleId", "cycle_id"],
        ["sessionId", "session_id"],
      ] as const) {
        const value = parsed[field]
        if (value !== undefined) add((position) => `${column} = $${position}`, value)
      }
      if (parsed.eventTypes !== undefined) {
        add((position) => `event_type = ANY($${position}::text[])`, parsed.eventTypes)
      }
      values.push(parsed.limit)
      const direction = parsed.direction ?? "ASC"
      const result = await pool.query<PostgresLedgerRow>(
        `SELECT ${SELECT_COLUMNS}
         FROM ledger_events
         WHERE ${where.join(" AND ")}
         ORDER BY sequence ${direction}
         LIMIT $${values.length}`,
        values,
      )
      return result.rows.map(decodeRow)
    },

    async close() {
      if (closed) return
      closed = true
      await pool.end()
    },
  }
}
