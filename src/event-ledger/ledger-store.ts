import type {
  LedgerEvent,
  LedgerEventV2,
  StoredLedgerEvent,
  StoredLedgerEventV2,
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
    event: LedgerEventV2,
    signal?: AbortSignal,
  ): Promise<StoredLedgerEventV2>
  appendBatch(
    events: readonly LedgerEventV2[],
    signal?: AbortSignal,
  ): Promise<readonly StoredLedgerEventV2[]>
  getByEventId(eventId: string): Promise<StoredLedgerEvent | undefined>
  list(query: LedgerEventQuery): Promise<readonly StoredLedgerEvent[]>
  close(): Promise<void>
}>
