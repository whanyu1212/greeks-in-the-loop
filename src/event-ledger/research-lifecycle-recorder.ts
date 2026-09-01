import { randomUUID } from "node:crypto"

import type {
  ResearchCycleOutcomeSink,
  ResearchCycleTerminalRecordV3,
  ResearchCycleTerminalRecordV4,
} from "../research/cycle/outcome.js"
import {
  RESEARCH_INVOCATION_VERSION,
  type ResearchModelDriftCode,
} from "../research/invocation.js"
import {
  researchEligibilityV1Schema,
  type ResearchEligibilityV1,
} from "../scheduling/research-eligibility.js"
import {
  LEDGER_EVENT_VERSION,
  RESEARCH_LOOP_BREAKER_STATE_VERSION,
  type LedgerEventV4,
} from "./ledger-event-v1.js"
import type { LedgerStore } from "./ledger-store.js"
import { deriveExecutionAuthorizationV1 } from "../execution/authorization-v1.js"

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
    /**
     * Records that the observed model identity failed the pinned assertion.
     * The cycle is then failed by its caller, so this only preserves why.
     */
    recordInvocationIdentityRejected(
      drift: Readonly<{
        reason: ResearchModelDriftCode
        expected: string
        observed: string
      }>,
      signal?: AbortSignal,
    ): Promise<void>
    interrupt(
      reason: ResearchCycleInterruptionReason,
      signal?: AbortSignal,
    ): Promise<void>
  }>

export type ResearchLoopBreakerState =
  | Readonly<{ latched: false }>
  | Readonly<{
      latched: true
      consecutiveFailures: number
      threshold: number
      lastAttempt: number
    }>

export type ResearchLifecycleRecorder = Readonly<{
  loadResearchLoopBreakerState(): Promise<ResearchLoopBreakerState>
  recordResearchLoopBreakerLatched(state: Readonly<{
    consecutiveFailures: number
    threshold: number
    lastAttempt: number
  }>): Promise<void>
  recordResearchLoopBreakerReset(): Promise<void>
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
  record: ResearchCycleTerminalRecordV3 | ResearchCycleTerminalRecordV4,
  identity: ResearchCycleIdentity,
  startEventId: string,
  occurredAt: string,
  idFactory: () => string,
  executionWindowDeadline?: string,
): LedgerEventV4[] => {
  if (record.researchInvocation === undefined) {
    throw new Error("Completed research cycles require invocation metadata")
  }
  const events: LedgerEventV4[] = []
  let causationEventId = startEventId

  const append = (event: LedgerEventV4) => {
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

  append({
    ...envelope(),
    eventType: "RESEARCH_SYMBOL_SCREEN_RECORDED",
    payload: {
      screen: {
        ...record.symbolScreen,
        symbols: record.symbolScreen.symbols.map((symbol) => ({
          ...symbol,
          strategies: [...symbol.strategies],
        })),
      },
    },
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
  const validatedDecision =
    record.validatedDecision ??
    (outcome.status === "VALIDATED_NO_ACTION" ||
    outcome.status === "PORTFOLIO_EVALUATED"
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
    case "VALIDATED_NO_ACTION":
      break
    case "DECISION_REJECTED":
      if (
        outcome.issues.some(
          (issue) =>
            issue.code === "SCHEMA_INVALID" &&
            (!("schemaCategory" in issue) || issue.schemaCategory === undefined),
        )
      ) {
        throw new Error("New schema rejections require a safe diagnostic category")
      }
      append({
        ...envelope(),
        eventType: "RESEARCH_DECISION_REJECTED",
        payload: {
          issues: outcome.issues.map((issue) => ({
            code: issue.code,
            path: [...issue.path],
            ...(!("schemaCategory" in issue) || issue.schemaCategory === undefined
              ? {}
              : { schemaCategory: issue.schemaCategory }),
          })),
        },
      })
      break
    case "PORTFOLIO_EVALUATED":
      for (const proposal of outcome.proposals) {
        if (proposal.status === "DECISION_REJECTED") {
          append({
            ...envelope(),
            eventType: "RESEARCH_DECISION_REJECTED",
            payload: {
              proposal: {
                priority: proposal.priority,
                underlying: proposal.underlying,
              },
              issues: proposal.issues.map((issue) => ({
                code: issue.code,
                path: [...issue.path],
                ...(!("schemaCategory" in issue) ||
                    issue.schemaCategory === undefined
                  ? {}
                  : { schemaCategory: issue.schemaCategory }),
              })),
            },
          })
          continue
        }
        if (proposal.status === "INTENT_DERIVATION_REJECTED") {
          append({
            ...envelope(),
            eventType: "TRADE_INTENT_DERIVATION_REJECTED",
            payload: {
              proposal: {
                priority: proposal.priority,
                underlying: proposal.underlying,
              },
              reasons: [...proposal.reasons],
            },
          })
          continue
        }
        append({
          ...envelope(),
          eventType: "TRADE_INTENT_DERIVED",
          payload: { intent: proposal.intent },
        })
        const riskEvent: LedgerEventV4 = {
          ...envelope(),
          eventType: "RISK_SHADOW_DECISION_RECORDED",
          payload: { decision: proposal.shadowRisk.decision },
        }
        append(riskEvent)
        const authorization =
          proposal.selected &&
          record.researchInvocation.cycleMode === "STANDARD" &&
          executionWindowDeadline !== undefined
            ? deriveExecutionAuthorizationV1({
                authorizationId: identity.cycleId,
                issuedAt: occurredAt,
                expiresAt: executionWindowDeadline,
                riskDecision: proposal.shadowRisk.decision,
              })
            : undefined
        if (authorization !== undefined) {
          append({
            ...envelope(),
            eventType: "EXECUTION_AUTHORIZATION_RECORDED",
            payload: { instruction: authorization },
          })
        }
        for (const transition of proposal.shadowRisk.breakerTransitions) {
          append({
            ...envelope(),
            eventType: "RISK_BREAKER_LATCHED",
            payload: transition,
          })
        }
      }
      append({
        ...envelope(),
        eventType: "PORTFOLIO_SHADOW_PLAN_RECORDED",
        payload: {
          proposalCount: outcome.proposals.length,
          selectedUnderlyings: outcome.proposals.flatMap((proposal) =>
            proposal.status === "RISK_EVALUATED" && proposal.selected
              ? [proposal.underlying]
              : [],
          ),
        },
      })
      break
  }

  append({
    ...envelope(),
    eventType: "RESEARCH_CYCLE_COMPLETED",
    payload: {
      status: outcome.status,
      researchInvocation: record.researchInvocation,
    },
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
    async loadResearchLoopBreakerState() {
      const [latest] = await persist("research-loop breaker query", () =>
        store.list({
          direction: "DESC",
          eventTypes: [
            "RESEARCH_LOOP_BREAKER_LATCHED",
            "RESEARCH_LOOP_BREAKER_RESET",
          ],
          limit: 1,
        }),
      )
      if (latest?.eventType !== "RESEARCH_LOOP_BREAKER_LATCHED") {
        return { latched: false }
      }
      return {
        latched: true,
        consecutiveFailures: latest.payload.consecutiveFailures,
        threshold: latest.payload.threshold,
        lastAttempt: latest.payload.lastAttempt,
      }
    },

    async recordResearchLoopBreakerLatched(state) {
      await persist("research-loop breaker latch append", () =>
        store.append({
          eventId: idFactory(),
          eventVersion: LEDGER_EVENT_VERSION,
          eventType: "RESEARCH_LOOP_BREAKER_LATCHED",
          occurredAt: now().toISOString(),
          correlationId: idFactory(),
          payload: {
            stateVersion: RESEARCH_LOOP_BREAKER_STATE_VERSION,
            reason: "CONSECUTIVE_FAILURE_LIMIT",
            consecutiveFailures: state.consecutiveFailures,
            threshold: state.threshold,
            lastAttempt: state.lastAttempt,
          },
        }),
      )
    },

    async recordResearchLoopBreakerReset() {
      await persist("research-loop breaker reset append", () =>
        store.append({
          eventId: idFactory(),
          eventVersion: LEDGER_EVENT_VERSION,
          eventType: "RESEARCH_LOOP_BREAKER_RESET",
          occurredAt: now().toISOString(),
          correlationId: idFactory(),
          payload: {
            stateVersion: RESEARCH_LOOP_BREAKER_STATE_VERSION,
            reason: "OPERATOR_REQUESTED",
          },
        }),
      )
    },

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
                  initialEligibility?.tradeIntentWindow?.deadline,
                ),
                recordSignal,
              ),
            )
          }),
      }

      return {
        ...identity,
        outcomeSink,
        // Not terminalized: the caller throws after this, and the resulting
        // cycle interruption is what closes the cycle out.
        recordInvocationIdentityRejected: async (drift, driftSignal) => {
          driftSignal?.throwIfAborted()
          await persist("invocation-identity rejection append", () =>
            store.append(
              {
                eventId: idFactory(),
                eventVersion: LEDGER_EVENT_VERSION,
                eventType: "RESEARCH_INVOCATION_IDENTITY_REJECTED",
                occurredAt: now().toISOString(),
                correlationId: identity.correlationId,
                causationEventId: startEventId,
                cycleId: identity.cycleId,
                sessionId: identity.sessionId,
                payload: {
                  invocationVersion: RESEARCH_INVOCATION_VERSION,
                  reason: drift.reason,
                  expected: drift.expected,
                  observed: drift.observed,
                },
              },
              driftSignal,
            ),
          )
        },
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
