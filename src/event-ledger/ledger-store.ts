import type {
  LedgerEventV1,
  StoredLedgerEventV1,
} from "./ledger-event-v1.js"

export type LedgerEventQuery = Readonly<{
  afterSequence?: number
  beforeSequence?: number
  direction?: "ASC" | "DESC"
  correlationId?: string
  cycleId?: string
  sessionId?: string
  eventTypes?: readonly LedgerEventV1["eventType"][]
  limit: number
}>

export type LedgerStore = Readonly<{
  migrate(signal?: AbortSignal): Promise<void>
  append(
    event: LedgerEventV1,
    signal?: AbortSignal,
  ): Promise<StoredLedgerEventV1>
  appendBatch(
    events: readonly LedgerEventV1[],
    signal?: AbortSignal,
  ): Promise<readonly StoredLedgerEventV1[]>
  getByEventId(eventId: string): Promise<StoredLedgerEventV1 | undefined>
  list(query: LedgerEventQuery): Promise<readonly StoredLedgerEventV1[]>
  close(): Promise<void>
}>
