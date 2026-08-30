import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import Database from "better-sqlite3"

import { assertPersistenceSafe } from "../event-ledger/persistence-safety.js"
import {
  canonicalJson,
  canonicalJsonSha256,
} from "../shared/canonical-json.js"
import {
  BACKTEST_DATASET_VERSION,
  backtestDatasetPartitionV1Schema,
  backtestPartitionRequestV1Schema,
  type BacktestDatasetPartitionV1,
  type BacktestPartitionKind,
  type BacktestPartitionRequestV1,
} from "./dataset-v1.js"
import {
  backtestRecordKey,
  decodeBacktestDatasetDefinition,
  decodeBacktestDatasetManifest,
  expectedBacktestPartitionKeys,
  parseBacktestDatasetRecord,
  type BacktestDatasetDefinition,
  type BacktestDatasetManifest,
  type BacktestDatasetRecord,
} from "./dataset.js"

const SCHEMA_VERSION = "1" as const
const LIMITATIONS = [
  "Alpaca historical options coverage begins in February 2024.",
  "Historical option bars and trades do not reconstruct point-in-time NBBO quotes.",
  "Historical chains, Greeks, implied volatility, and open-interest history are unavailable unless captured separately.",
] as const

type PartitionRow = Readonly<{
  partition_key: string
  kind: string
  request_json: string
  status: string
  page_count: number
  row_count: number
  next_page_token: string | null
  checksum: string | null
  updated_at: string
}>

const decodePartition = (row: PartitionRow): BacktestDatasetPartitionV1 =>
  backtestDatasetPartitionV1Schema.parse({
    partitionKey: row.partition_key,
    kind: row.kind,
    request: JSON.parse(row.request_json) as unknown,
    status: row.status,
    pageCount: row.page_count,
    rowCount: row.row_count,
    ...(row.next_page_token === null ? {} : { nextPageToken: row.next_page_token }),
    ...(row.checksum === null ? {} : { checksum: row.checksum }),
    updatedAt: row.updated_at,
  })

export type BacktestDatasetStore = Readonly<{
  definition: BacktestDatasetDefinition
  getPartition(partitionKey: string): BacktestDatasetPartitionV1 | undefined
  beginPartition(input: Readonly<{
    partitionKey: string
    kind: BacktestPartitionKind
    request: BacktestPartitionRequestV1
    updatedAt: string
  }>): BacktestDatasetPartitionV1
  appendPage(input: Readonly<{
    partitionKey: string
    expectedPageToken?: string
    records: readonly BacktestDatasetRecord[]
    nextPageToken?: string
    updatedAt: string
  }>): BacktestDatasetPartitionV1
  completePartition(partitionKey: string, updatedAt: string): BacktestDatasetPartitionV1
  listRecords(input?: Readonly<{
    partitionKey?: string
    recordType?: BacktestDatasetRecord["recordType"]
  }>): readonly BacktestDatasetRecord[]
  manifest(): BacktestDatasetManifest
  close(): void
}>

export type CreateBacktestDatasetStoreOptions = Readonly<{
  path: string
  definition?: BacktestDatasetDefinition
  knownCredentialValues?: readonly string[]
  readonly?: boolean
}>

/** Opens a standalone, checksummed SQLite dataset used only by backtests. */
export function createBacktestDatasetStore({
  path,
  definition,
  knownCredentialValues = [],
  readonly = false,
}: CreateBacktestDatasetStoreOptions): BacktestDatasetStore {
  if (!readonly) mkdirSync(dirname(path), { recursive: true })
  const database = new Database(path, {
    readonly,
    fileMustExist: readonly,
  })
  database.pragma("foreign_keys = ON")
  database.pragma("busy_timeout = 5000")
  if (!readonly) {
    database.pragma("journal_mode = WAL")
    database.pragma("synchronous = FULL")
    database.exec(`
      CREATE TABLE IF NOT EXISTS dataset_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dataset_partitions (
        partition_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL,
        page_count INTEGER NOT NULL,
        row_count INTEGER NOT NULL,
        next_page_token TEXT,
        checksum TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dataset_records (
        partition_key TEXT NOT NULL REFERENCES dataset_partitions(partition_key),
        record_key TEXT NOT NULL,
        record_type TEXT NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (partition_key, record_key)
      );
      CREATE INDEX IF NOT EXISTS dataset_records_type
        ON dataset_records(record_type, record_key);
    `)
  }

  const getMetadata = database.prepare(
    "SELECT value FROM dataset_metadata WHERE key = ?",
  )
  const insertMetadata = database.prepare(
    "INSERT INTO dataset_metadata (key, value) VALUES (?, ?)",
  )
  const existingSchema = getMetadata.get("schema_version") as
    | { value: string }
    | undefined
  const existingDefinition = getMetadata.get("definition") as
    | { value: string }
    | undefined

  if (existingSchema === undefined) {
    if (readonly || definition === undefined) {
      database.close()
      throw new Error("Backtest dataset is not initialized")
    }
    const parsedDefinition = decodeBacktestDatasetDefinition(definition)
    assertPersistenceSafe(parsedDefinition, knownCredentialValues)
    const initialize = database.transaction(() => {
      insertMetadata.run("schema_version", SCHEMA_VERSION)
      insertMetadata.run("definition", canonicalJson(parsedDefinition))
    })
    initialize.immediate()
  } else if (
    existingSchema.value !== SCHEMA_VERSION ||
    existingDefinition === undefined
  ) {
    database.close()
    throw new Error("Backtest dataset schema is unsupported")
  }

  const storedDefinition = decodeBacktestDatasetDefinition(
    JSON.parse(
      (getMetadata.get("definition") as { value: string }).value,
    ) as unknown,
  )
  const expectedPartitionKeys = new Set(
    expectedBacktestPartitionKeys(storedDefinition),
  )
  if (
    definition !== undefined &&
    canonicalJson(decodeBacktestDatasetDefinition(definition)) !==
      canonicalJson(storedDefinition)
  ) {
    database.close()
    throw new Error("Backtest dataset definition does not match the existing file")
  }

  let closed = false
  const assertOpen = () => {
    if (closed || !database.open) throw new Error("Backtest dataset store is closed")
  }
  const assertWritable = () => {
    if (readonly) throw new Error("Backtest dataset store is read-only")
  }
  const selectPartition = database.prepare(
    "SELECT * FROM dataset_partitions WHERE partition_key = ?",
  )
  const readPartition = (partitionKey: string) => {
    const row = selectPartition.get(partitionKey) as PartitionRow | undefined
    return row === undefined ? undefined : decodePartition(row)
  }

  return {
    definition: storedDefinition,
    getPartition(partitionKey) {
      assertOpen()
      return readPartition(partitionKey)
    },
    beginPartition(input) {
      assertOpen()
      assertWritable()
      if (!expectedPartitionKeys.has(input.partitionKey)) {
        throw new Error("Backtest partition is not declared by the dataset")
      }
      const request = backtestPartitionRequestV1Schema.parse(input.request)
      assertPersistenceSafe(request, knownCredentialValues)
      const existing = readPartition(input.partitionKey)
      if (existing !== undefined) {
        if (
          existing.kind !== input.kind ||
          canonicalJson(existing.request) !== canonicalJson(request)
        ) {
          throw new Error("Backtest partition definition changed")
        }
        return existing
      }
      database.prepare(`
        INSERT INTO dataset_partitions (
          partition_key, kind, request_json, status, page_count, row_count,
          next_page_token, checksum, updated_at
        ) VALUES (?, ?, ?, 'IN_PROGRESS', 0, 0, NULL, NULL, ?)
      `).run(input.partitionKey, input.kind, canonicalJson(request), input.updatedAt)
      return readPartition(input.partitionKey)!
    },
    appendPage(input) {
      assertOpen()
      assertWritable()
      const records = input.records.map((record) =>
        parseBacktestDatasetRecord(storedDefinition, record),
      )
      assertPersistenceSafe(records, knownCredentialValues)
      const append = database.transaction(() => {
        const partition = readPartition(input.partitionKey)
        if (partition === undefined) throw new Error("Backtest partition was not started")
        if (partition.status === "COMPLETE") {
          throw new Error("Completed backtest partitions are immutable")
        }
        if (partition.nextPageToken !== input.expectedPageToken) {
          throw new Error("Backtest partition page token changed")
        }

        const insert = database.prepare(`
          INSERT OR IGNORE INTO dataset_records (
            partition_key, record_key, record_type, record_json
          ) VALUES (?, ?, ?, ?)
        `)
        const select = database.prepare(`
          SELECT record_json FROM dataset_records
          WHERE partition_key = ? AND record_key = ?
        `)
        for (const record of records) {
          const key = backtestRecordKey(record)
          const json = canonicalJson(record)
          insert.run(input.partitionKey, key, record.recordType, json)
          const retained = select.get(input.partitionKey, key) as { record_json: string }
          if (retained.record_json !== json) {
            throw new Error("Backtest record conflicts with retained data")
          }
        }
        const rowCount = (
          database.prepare(
            "SELECT COUNT(*) AS count FROM dataset_records WHERE partition_key = ?",
          ).get(input.partitionKey) as { count: number }
        ).count
        database.prepare(`
          UPDATE dataset_partitions
          SET page_count = page_count + 1, row_count = ?, next_page_token = ?,
              updated_at = ?
          WHERE partition_key = ?
        `).run(
          rowCount,
          input.nextPageToken ?? null,
          input.updatedAt,
          input.partitionKey,
        )
      })
      append.immediate()
      return readPartition(input.partitionKey)!
    },
    completePartition(partitionKey, updatedAt) {
      assertOpen()
      assertWritable()
      const complete = database.transaction(() => {
        const partition = readPartition(partitionKey)
        if (partition === undefined) throw new Error("Backtest partition was not started")
        if (partition.status === "COMPLETE") return
        if (partition.nextPageToken !== undefined) {
          throw new Error("Backtest partition still has another page")
        }
        const records = database.prepare(`
          SELECT record_json FROM dataset_records
          WHERE partition_key = ? ORDER BY record_key ASC
        `).all(partitionKey) as { record_json: string }[]
        const checksum = canonicalJsonSha256(
          records.map(({ record_json }) => JSON.parse(record_json) as unknown),
        )
        database.prepare(`
          UPDATE dataset_partitions
          SET status = 'COMPLETE', checksum = ?, updated_at = ?
          WHERE partition_key = ?
        `).run(checksum, updatedAt, partitionKey)
      })
      complete.immediate()
      return readPartition(partitionKey)!
    },
    listRecords(input = {}) {
      assertOpen()
      const conditions: string[] = []
      const parameters: string[] = []
      if (input.partitionKey !== undefined) {
        conditions.push("partition_key = ?")
        parameters.push(input.partitionKey)
      }
      if (input.recordType !== undefined) {
        conditions.push("record_type = ?")
        parameters.push(input.recordType)
      }
      const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`
      const rows = database.prepare(`
        SELECT record_json FROM dataset_records ${where}
        ORDER BY partition_key ASC, record_key ASC
      `).all(...parameters) as { record_json: string }[]
      return rows.map(({ record_json }) =>
        parseBacktestDatasetRecord(
          storedDefinition,
          JSON.parse(record_json) as unknown,
        ),
      )
    },
    manifest() {
      assertOpen()
      const partitions = (
        database.prepare(
          "SELECT * FROM dataset_partitions ORDER BY partition_key ASC",
        ).all() as PartitionRow[]
      ).map(decodePartition)
      for (const partition of partitions) {
        if (partition.status !== "COMPLETE") continue
        const records = database.prepare(`
          SELECT record_json FROM dataset_records
          WHERE partition_key = ? ORDER BY record_key ASC
        `).all(partition.partitionKey) as { record_json: string }[]
        const retainedChecksum = canonicalJsonSha256(
          records.map(({ record_json }) => JSON.parse(record_json) as unknown),
        )
        if (retainedChecksum !== partition.checksum) {
          throw new Error("Backtest partition checksum verification failed")
        }
      }
      const content = {
        definition: storedDefinition,
        partitions,
        complete:
          expectedPartitionKeys.size === partitions.length &&
          partitions.every(
            ({ partitionKey, status }) =>
              expectedPartitionKeys.has(partitionKey) && status === "COMPLETE",
          ),
        limitations: [...LIMITATIONS],
      }
      return decodeBacktestDatasetManifest({
        ...content,
        checksum: canonicalJsonSha256(content),
      })
    },
    close() {
      if (closed) return
      database.close()
      closed = true
    },
  }
}

export const BACKTEST_DATASET_SQLITE_VERSION = `${BACKTEST_DATASET_VERSION}+sqlite.${SCHEMA_VERSION}`
