import { randomUUID } from "node:crypto"

import type {
  ResearchCycleOutcomeSink,
  ResearchCycleTerminalRecordV1,
} from "../research/research-cycle-outcome-v1.js"
import {
  researchEligibilityV1Schema,
  type ResearchEligibilityV1,
} from "../scheduling/research-eligibility.js"
import {
  LEDGER_EVENT_VERSION,
  type LedgerEventV1,
} from "./ledger-event-v1.js"
import type { LedgerStore } from "./ledger-store.js"

export const RESEARCH_CYCLE_INTERRUPTION_REASONS = [
  "TIMEOUT",
  "CANCELLED",
  "SHUTDOWN",
  "PROCESS_RESTART",
  "FAILED",
] as const

export type ResearchCycleInterruptionReason =
  (typeof RESEARCH_CYCLE_INTERRUPTION_REASONS)[number]

export type ResearchCycleIdentity = Readonly<{
  cycleId: string
  correlationId: string
  sessionId: string
  cycleNumber: number
  startedAt: string
}>

export type ActiveResearchCycle = ResearchCycleIdentity &
  Readonly<{
    outcomeSink: ResearchCycleOutcomeSink
    interrupt(
      reason: ResearchCycleInterruptionReason,
      signal?: AbortSignal,
    ): Promise<void>
  }>

export type ResearchLifecycleRecorder = Readonly<{
  recordOpenCodeSessionStarted(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<void>
  startCycle(
    options: Readonly<{
      sessionId: string
      cycleNumber: number
      signal?: AbortSignal
    }> &
      (
        | Readonly<{
            sessionDate: string
            initialEligibility: ResearchEligibilityV1
          }>
        | Readonly<{
            sessionDate?: undefined
            initialEligibility?: undefined
          }>
      ),
  ): Promise<ActiveResearchCycle>
}>

export type CreateResearchLifecycleRecorderOptions = Readonly<{
  store: LedgerStore
  idFactory?: () => string
  now?: () => Date
}>

export class LedgerPersistenceError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`Ledger ${operation} failed`, { cause })
    this.name = "LedgerPersistenceError"
  }
}

const persist = async <T>(
  operation: string,
  write: () => Promise<T>,
): Promise<T> => {
  try {
    return await write()
  } catch (error) {
    if (error instanceof LedgerPersistenceError) throw error
    throw new LedgerPersistenceError(operation, error)
  }
}

const completionEvents = (
  record: ResearchCycleTerminalRecordV1,
  identity: ResearchCycleIdentity,
  startEventId: string,
  occurredAt: string,
  idFactory: () => string,
): LedgerEventV1[] => {
  const events: LedgerEventV1[] = []
  let causationEventId = startEventId

  const append = (event: LedgerEventV1) => {
    events.push(event)
    causationEventId = event.eventId
  }
  const envelope = () => ({
    eventId: idFactory(),
    eventVersion: LEDGER_EVENT_VERSION,
    occurredAt,
    correlationId: identity.correlationId,
    causationEventId,
    cycleId: identity.cycleId,
    sessionId: identity.sessionId,
  })

  for (const snapshot of record.evidenceSnapshots) {
    append({
      ...envelope(),
      eventType: "EVIDENCE_SNAPSHOT_REFERENCED",
      payload: { ...snapshot },
    })
  }

  const outcome = record.outcome
  if (record.researchReport !== undefined) {
    append({
      ...envelope(),
      eventType: "RESEARCH_REPORT_RECORDED",
      payload: { report: record.researchReport },
    })
  }
  const preliminaryResearch =
    record.preliminaryResearch ??
    (outcome.status === "PRELIMINARY_RESEARCH_RETAINED"
      ? outcome.research
      : undefined)
  if (preliminaryResearch !== undefined) {
    append({
      ...envelope(),
      eventType: "PRELIMINARY_RESEARCH_RECORDED",
      payload: { research: preliminaryResearch },
    })
  }
  const validatedDecision =
    record.validatedDecision ??
    (outcome.status === "VALIDATED_NO_ACTION" ||
    outcome.status === "INTENT_DERIVED"
      ? outcome.decision
      : undefined)
  if (validatedDecision !== undefined) {
    append({
      ...envelope(),
      eventType: "RESEARCH_DECISION_VALIDATED",
      payload: { decision: validatedDecision },
    })
  }

  switch (outcome.status) {
    case "PRELIMINARY_RESEARCH_RETAINED":
      break
    case "VALIDATED_NO_ACTION":
      break
    case "DECISION_REJECTED":
      append({
        ...envelope(),
        eventType: "RESEARCH_DECISION_REJECTED",
        payload: {
          issues: outcome.issues.map(({ code, path }) => ({
            code,
            path: [...path],
          })),
        },
      })
      break
    case "INTENT_DERIVATION_REJECTED":
      append({
        ...envelope(),
        eventType: "TRADE_INTENT_DERIVATION_REJECTED",
        payload: { reasons: [...outcome.reasons] },
      })
      break
    case "INTENT_DERIVED":
      append({
        ...envelope(),
        eventType: "TRADE_INTENT_DERIVED",
        payload: { intent: outcome.intent },
      })
      if (record.shadowRisk === undefined) {
        throw new Error("Derived intent completion requires shadow risk")
      }
      append({
        ...envelope(),
        eventType: "RISK_SHADOW_DECISION_RECORDED",
        payload: { decision: record.shadowRisk.decision },
      })
      for (const transition of record.shadowRisk.breakerTransitions) {
        append({
          ...envelope(),
          eventType: "RISK_BREAKER_LATCHED",
          payload: transition,
        })
      }
      break
  }

  append({
    ...envelope(),
    eventType: "RESEARCH_CYCLE_COMPLETED",
    payload: { status: outcome.status },
  })

  return events
}

/**
 * Creates the storage-neutral lifecycle boundary used by the research worker.
 * Each active cycle arbitrates terminal writes in memory while the store's
 * atomic batch and lifecycle constraints provide the durable backstop.
 */
export function createResearchLifecycleRecorder({
  store,
  idFactory = randomUUID,
  now = () => new Date(),
}: CreateResearchLifecycleRecorderOptions): ResearchLifecycleRecorder {
  return {
    async recordOpenCodeSessionStarted(sessionId, signal) {
      signal?.throwIfAborted()
      await persist("session-start append", () =>
        store.append(
          {
            eventId: idFactory(),
            eventVersion: LEDGER_EVENT_VERSION,
            eventType: "OPENCODE_SESSION_STARTED",
            occurredAt: now().toISOString(),
            correlationId: idFactory(),
            sessionId,
            payload: { sessionId },
          },
          signal,
        ),
      )
    },

    async startCycle({
      sessionId,
      cycleNumber,
      sessionDate,
      initialEligibility,
      signal,
    }) {
      signal?.throwIfAborted()
      const identity: ResearchCycleIdentity = {
        cycleId: idFactory(),
        correlationId: idFactory(),
        sessionId,
        cycleNumber,
        startedAt: now().toISOString(),
      }
      const startEventId = idFactory()
      await persist("cycle-start append", () =>
        store.append(
          {
            eventId: startEventId,
            eventVersion: LEDGER_EVENT_VERSION,
            eventType: "RESEARCH_CYCLE_STARTED",
            occurredAt: identity.startedAt,
            correlationId: identity.correlationId,
            cycleId: identity.cycleId,
            sessionId: identity.sessionId,
            payload: {
              cycleNumber: identity.cycleNumber,
              ...(sessionDate === undefined ? {} : { sessionDate }),
              ...(initialEligibility === undefined
                ? {}
                : {
                    initialEligibility:
                      researchEligibilityV1Schema.parse(initialEligibility),
                  }),
            },
          },
          signal,
        ),
      )

      let terminalCommitted = false
      let terminalAttempt: Promise<void> | undefined

      const terminalize = async (
        operation: () => Promise<void>,
      ): Promise<void> => {
        while (true) {
          if (terminalCommitted) return
          if (terminalAttempt !== undefined) {
            try {
              await terminalAttempt
              return
            } catch {
              continue
            }
          }

          const attempt = operation()
          terminalAttempt = attempt
          try {
            await attempt
            terminalCommitted = true
            return
          } finally {
            if (terminalAttempt === attempt) terminalAttempt = undefined
          }
        }
      }

      const outcomeSink: ResearchCycleOutcomeSink = {
        record: (record, recordSignal) =>
          terminalize(async () => {
            recordSignal.throwIfAborted()
            await persist("cycle-completion append", () =>
              store.appendBatch(
                completionEvents(
                  record,
                  identity,
                  startEventId,
                  now().toISOString(),
                  idFactory,
                ),
                recordSignal,
              ),
            )
          }),
      }

      return {
        ...identity,
        outcomeSink,
        interrupt: (reason, interruptSignal) =>
          terminalize(async () => {
            interruptSignal?.throwIfAborted()
            await persist("cycle-interruption append", () =>
              store.append(
                {
                  eventId: idFactory(),
                  eventVersion: LEDGER_EVENT_VERSION,
                  eventType: "RESEARCH_CYCLE_INTERRUPTED",
                  occurredAt: now().toISOString(),
                  correlationId: identity.correlationId,
                  causationEventId: startEventId,
                  cycleId: identity.cycleId,
                  sessionId: identity.sessionId,
                  payload: { reason },
                },
                interruptSignal,
              ),
            )
          }),
      }
    },
  }
}
