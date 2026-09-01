import { randomUUID } from "node:crypto"

import {
  LEDGER_EVENT_VERSION,
  type LedgerEventV4,
} from "../event-ledger/ledger-event-v1.js"
import type { LedgerStore } from "../event-ledger/ledger-store.js"
import { LedgerPersistenceError } from "../event-ledger/research-lifecycle-recorder.js"
import {
  TRADE_INTENT_V4_CONTRACT_VERSION,
  type TradeIntentV4,
} from "../contracts/trade-intent-v4.js"
import type { ShadowRiskResultV1 } from "../risk/shadow-risk-v1.js"
import type { OrderSubmitter } from "./alpaca-order-submitter.js"
import {
  ORDER_SUBMISSION_VERSION,
  createOrderSubmittedPayloadV1,
  type OrderTerminalRejectionCode,
} from "./order-submission-v1.js"

/**
 * Deterministic execution of one approved shadow decision.
 *
 * Ordering is the safety property. `ORDER_SUBMITTED` is durably appended
 * before the broker is contacted, so a crash anywhere after that point leaves
 * a record that startup reconciliation can resolve by client order id. The
 * ledger therefore never holds an order the broker does not have, and never
 * misses one it does.
 */

export type TradeExecutionOutcome =
  | Readonly<{ status: "SKIPPED"; reason: string }>
  | Readonly<{ status: "FILLED"; brokerOrderId: string; clientOrderId: string }>
  | Readonly<{ status: "OPEN"; brokerOrderId: string; clientOrderId: string }>
  | Readonly<{
      status: "REJECTED"
      reason: OrderTerminalRejectionCode
      clientOrderId: string
    }>

export type ExecuteApprovedTradeOptions = Readonly<{
  store: LedgerStore
  submitter: OrderSubmitter
  shadowRisk: ShadowRiskResultV1
  cycleId: string
  signal: AbortSignal
  idFactory?: () => string
  now?: () => Date
}>

const isoTimestamp = (date: Date) => date.toISOString()

/**
 * Finds the durable shadow-risk event that authorizes this execution.
 *
 * The causation link is required by the ledger trigger, so resolving it here
 * doubles as the check that the approval was actually persisted. The event
 * also carries the cycle's correlation and session identity, which the ledger
 * requires order events to match; taking it from here rather than from the
 * caller removes the only way those could drift apart.
 */
const findApprovedRiskEvent = async (store: LedgerStore, cycleId: string) => {
  const events = await store.list({
    cycleId,
    eventTypes: ["RISK_SHADOW_DECISION_RECORDED"],
    direction: "DESC",
    limit: 1,
  })
  const event = events[0]
  if (event === undefined) return undefined
  const decision = (event.payload as { decision?: { outcome?: unknown } })
    .decision
  return decision?.outcome === "APPROVED" ? event : undefined
}

/**
 * Submits one approved trade intent and records its terminal broker state.
 *
 * @param options Ledger, broker, and the approved shadow decision.
 * @returns What happened, for the scheduler's printable report.
 */
export async function executeApprovedTradeV1({
  store,
  submitter,
  shadowRisk,
  cycleId,
  signal,
  idFactory = randomUUID,
  now = () => new Date(),
}: ExecuteApprovedTradeOptions): Promise<TradeExecutionOutcome> {
  signal.throwIfAborted()
  const decision = shadowRisk.decision
  if (
    decision.stage !== "EVALUATED" ||
    decision.outcome !== "APPROVED" ||
    decision.evaluation.outcome !== "APPROVED"
  ) {
    return { status: "SKIPPED", reason: "RISK_NOT_APPROVED" }
  }

  const riskEvent = await findApprovedRiskEvent(store, cycleId)
  if (riskEvent === undefined) {
    return { status: "SKIPPED", reason: "APPROVAL_NOT_RECORDED" }
  }

  // Stored decisions still decode legacy intent versions, but only a current
  // V4 intent carries the leg plan the Alpaca order request is built from.
  const intent = decision.evaluatedIntent
  if (intent.contractVersion !== TRADE_INTENT_V4_CONTRACT_VERSION) {
    return { status: "SKIPPED", reason: "INTENT_CONTRACT_UNSUPPORTED" }
  }
  const maxLossCents = decision.evaluation.maxLossCents
  if (maxLossCents === undefined) {
    return { status: "SKIPPED", reason: "APPROVAL_MISSING_MAX_LOSS" }
  }

  // The cycle id is the idempotency key: one approved entry per cycle, both
  // in the ledger (unique index) and at the broker (client order id).
  const clientOrderId = cycleId
  const envelope = (causationEventId: string) => ({
    eventId: idFactory(),
    eventVersion: LEDGER_EVENT_VERSION,
    occurredAt: isoTimestamp(now()),
    correlationId: riskEvent.correlationId,
    causationEventId,
    cycleId,
    ...(riskEvent.sessionId === undefined
      ? {}
      : { sessionId: riskEvent.sessionId }),
  })

  const submissionEvent: LedgerEventV4 = {
    ...envelope(riskEvent.eventId),
    eventType: "ORDER_SUBMITTED",
    payload: createOrderSubmittedPayloadV1(
      intent,
      clientOrderId,
      decision.ruleVersion,
      maxLossCents,
    ),
  }

  try {
    await store.append(submissionEvent, signal)
  } catch (error) {
    // The unique index rejects a second submission for this cycle. Treat that
    // as an already-executed cycle rather than retrying against the broker.
    const existing = await store.list({
      cycleId,
      eventTypes: ["ORDER_SUBMITTED"],
      limit: 1,
    })
    if (existing.length > 0) {
      return { status: "SKIPPED", reason: "ALREADY_SUBMITTED" }
    }
    throw new LedgerPersistenceError("order submission append", error)
  }

  const outcome = await submitter.submit({
    intent: intent as TradeIntentV4,
    clientOrderId,
    signal,
  })

  const appendTerminal = async (event: LedgerEventV4) => {
    try {
      await store.append(event, signal)
    } catch (error) {
      throw new LedgerPersistenceError("order terminal append", error)
    }
  }

  if (outcome.status === "FILLED") {
    await appendTerminal({
      ...envelope(submissionEvent.eventId),
      eventType: "ORDER_FILLED",
      payload: {
        submissionVersion: ORDER_SUBMISSION_VERSION,
        clientOrderId,
        brokerOrderId: outcome.brokerOrderId,
        filledQuantity: outcome.filledQuantity,
        ...(outcome.filledAvgPriceCentsPerShare === undefined
          ? {}
          : {
              filledAvgPriceCentsPerShare:
                outcome.filledAvgPriceCentsPerShare,
            }),
        brokerTimestamp: outcome.brokerTimestamp,
      },
    })
    return {
      status: "FILLED",
      brokerOrderId: outcome.brokerOrderId,
      clientOrderId,
    }
  }

  if (outcome.status === "REJECTED") {
    await appendTerminal({
      ...envelope(submissionEvent.eventId),
      eventType: "ORDER_REJECTED",
      payload: {
        submissionVersion: ORDER_SUBMISSION_VERSION,
        clientOrderId,
        ...(outcome.brokerOrderId === undefined
          ? {}
          : { brokerOrderId: outcome.brokerOrderId }),
        reason: outcome.reason,
        observedAt: isoTimestamp(now()),
      },
    })
    return { status: "REJECTED", reason: outcome.reason, clientOrderId }
  }

  // Working at the broker. Reconciliation resolves it; no terminal event yet.
  return {
    status: "OPEN",
    brokerOrderId: outcome.brokerOrderId,
    clientOrderId,
  }
}

export type ReconcileOpenOrdersOptions = Readonly<{
  store: LedgerStore
  submitter: OrderSubmitter
  signal: AbortSignal
  idFactory?: () => string
  now?: () => Date
  maxOrders?: number
}>

export type ReconciledOrderRecord = Readonly<{
  cycleId: string
  clientOrderId: string
  resolution: "FILLED" | "REJECTED" | "STILL_OPEN"
}>

/**
 * Resolves submissions that have no terminal event, at startup.
 *
 * This is what makes a crash between the submission record and the broker
 * response recoverable: the order is looked up by client order id and closed
 * out from what the broker actually holds. An order the broker never received
 * resolves to `SUBMISSION_ABANDONED`; it is never resubmitted here.
 */
export async function reconcileOpenOrderRecordsV1({
  store,
  submitter,
  signal,
  idFactory = randomUUID,
  now = () => new Date(),
  maxOrders = 100,
}: ReconcileOpenOrdersOptions): Promise<readonly ReconciledOrderRecord[]> {
  signal.throwIfAborted()
  const submissions = await store.list({
    eventTypes: ["ORDER_SUBMITTED"],
    direction: "DESC",
    limit: maxOrders,
  })
  if (submissions.length === 0) return []

  const terminals = await store.list({
    eventTypes: ["ORDER_FILLED", "ORDER_REJECTED"],
    direction: "DESC",
    limit: maxOrders,
  })
  const settledCycleIds = new Set(
    terminals.flatMap((event) => (event.cycleId ? [event.cycleId] : [])),
  )

  const reconciled: ReconciledOrderRecord[] = []
  for (const submission of submissions) {
    signal.throwIfAborted()
    const cycleId = submission.cycleId
    if (cycleId === undefined || settledCycleIds.has(cycleId)) continue
    const payload = submission.payload as {
      clientOrderId?: unknown
      correlationId?: unknown
    }
    const clientOrderId =
      typeof payload.clientOrderId === "string"
        ? payload.clientOrderId
        : undefined
    if (clientOrderId === undefined) continue

    const observed = await submitter.lookup({ clientOrderId, signal })
    if (observed !== undefined && observed.status === "OPEN") {
      reconciled.push({ cycleId, clientOrderId, resolution: "STILL_OPEN" })
      continue
    }

    const envelope = {
      eventId: idFactory(),
      eventVersion: LEDGER_EVENT_VERSION,
      occurredAt: isoTimestamp(now()),
      correlationId: submission.correlationId,
      causationEventId: submission.eventId,
      cycleId,
      ...(submission.sessionId === undefined
        ? {}
        : { sessionId: submission.sessionId }),
    }

    if (observed !== undefined && observed.status === "FILLED") {
      await store.append(
        {
          ...envelope,
          eventType: "ORDER_FILLED",
          payload: {
            submissionVersion: ORDER_SUBMISSION_VERSION,
            clientOrderId,
            brokerOrderId: observed.brokerOrderId,
            filledQuantity: observed.filledQuantity,
            ...(observed.filledAvgPriceCentsPerShare === undefined
              ? {}
              : {
                  filledAvgPriceCentsPerShare:
                    observed.filledAvgPriceCentsPerShare,
                }),
            brokerTimestamp: observed.brokerTimestamp,
          },
        },
        signal,
      )
      reconciled.push({ cycleId, clientOrderId, resolution: "FILLED" })
      continue
    }

    await store.append(
      {
        ...envelope,
        eventType: "ORDER_REJECTED",
        payload: {
          submissionVersion: ORDER_SUBMISSION_VERSION,
          clientOrderId,
          ...(observed?.status === "REJECTED" && observed.brokerOrderId
            ? { brokerOrderId: observed.brokerOrderId }
            : {}),
          reason:
            observed?.status === "REJECTED"
              ? observed.reason
              : "SUBMISSION_ABANDONED",
          observedAt: isoTimestamp(now()),
        },
      },
      signal,
    )
    reconciled.push({ cycleId, clientOrderId, resolution: "REJECTED" })
  }

  return reconciled
}

/**
 * Reports whether the ledger records a filled entry that is still held.
 *
 * No exit path exists yet, so a fill means an open position until it is
 * flattened manually. Callers use this to withhold trade-intent eligibility
 * before spending an agent cycle; the authoritative exposure check remains
 * `evaluateTradeIntentRiskV1`, which reads live broker state.
 */
export async function hasHeldExecutedEntryV1(
  store: LedgerStore,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted()
  const fills = await store.list({
    eventTypes: ["ORDER_FILLED"],
    direction: "DESC",
    limit: 1,
  })
  return fills.length > 0
}
