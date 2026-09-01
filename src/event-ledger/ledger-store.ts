import type {
  LedgerEvent,
  LedgerEventV4,
  StoredLedgerEvent,
  StoredLedgerEventV4,
} from "./ledger-event-v1.js"

export type LedgerEventQuery = Readonly<{
  afterSequence?: number
  beforeSequence?: number
  direction?: "ASC" | "DESC"
  correlationId?: string
  cycleId?: string
  sessionId?: string
  eventTypes?: readonly LedgerEvent["eventType"][]
  limit: number
}>

export type LedgerStore = Readonly<{
  migrate(signal?: AbortSignal): Promise<void>
  append(
    event: LedgerEventV4,
    signal?: AbortSignal,
  ): Promise<StoredLedgerEventV4>
  appendBatch(
    events: readonly LedgerEventV4[],
    signal?: AbortSignal,
  ): Promise<readonly StoredLedgerEventV4[]>
  getByEventId(eventId: string): Promise<StoredLedgerEvent | undefined>
  list(query: LedgerEventQuery): Promise<readonly StoredLedgerEvent[]>
  close(): Promise<void>
}>
