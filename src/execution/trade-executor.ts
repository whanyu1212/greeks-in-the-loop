import { randomUUID } from "node:crypto"

import {
  LEDGER_EVENT_VERSION,
  type LedgerEventV4,
} from "../event-ledger/ledger-event-v1.js"
import type { LedgerStore } from "../event-ledger/ledger-store.js"
import { LedgerPersistenceError } from "../event-ledger/research-lifecycle-recorder.js"
import {
  TRADE_INTENT_V4_CONTRACT_VERSION,
} from "../contracts/trade-intent-v4.js"
import type { ShadowRiskResultV1 } from "../risk/shadow-risk-v1.js"
import { canonicalJson } from "../shared/canonical-json.js"
import type { OrderSubmitter } from "./alpaca-order-submitter.js"
import {
  ORDER_SUBMISSION_VERSION,
  createOrderSubmittedPayloadV1,
  isSupportedExecutionIntentV1,
  type OrderTerminalRejectionCode,
} from "./order-submission-v1.js"

/**
 * Deterministic execution of one approved shadow decision.
 *
 * Ordering is the safety property. `ORDER_SUBMITTED` is durably appended
 * before the broker is contacted, so a crash anywhere after that point leaves
 * a record that explicit reconciliation can resolve by client order id. The
 * ledger may contain an attempt the broker never received, but cannot omit an
 * order that might have reached it.
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
  | Readonly<{
      status: "UNRESOLVED"
      reason: string
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
const findApprovedRiskEvent = async (
  store: LedgerStore,
  cycleId: string,
  expectedDecision: ShadowRiskResultV1["decision"],
) => {
  const events = await store.list({
    cycleId,
    eventTypes: ["RISK_SHADOW_DECISION_RECORDED"],
    direction: "DESC",
    limit: 16,
  })
  const expected = canonicalJson(expectedDecision)
  return events.find((event) => {
    const decision = (event.payload as { decision?: { outcome?: unknown } })
      .decision
    return (
      decision?.outcome === "APPROVED" && canonicalJson(decision) === expected
    )
  })
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

  const riskEvent = await findApprovedRiskEvent(store, cycleId, decision)
  if (riskEvent === undefined) {
    return { status: "SKIPPED", reason: "APPROVAL_NOT_RECORDED" }
  }

  // Stored decisions still decode legacy intent versions, but only a current
  // V4 intent carries the leg plan the Alpaca order request is built from.
  const intent = decision.evaluatedIntent
  if (intent.contractVersion !== TRADE_INTENT_V4_CONTRACT_VERSION) {
    return { status: "SKIPPED", reason: "INTENT_CONTRACT_UNSUPPORTED" }
  }
  if (!isSupportedExecutionIntentV1(intent)) {
    return { status: "SKIPPED", reason: "EXECUTION_INTENT_UNSUPPORTED" }
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
    intent,
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

  if (outcome.status === "UNKNOWN") {
    return { status: "UNRESOLVED", reason: outcome.reason, clientOrderId }
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
  notFoundGraceMs?: number
}>

export type ReconciledOrderRecord = Readonly<{
  cycleId: string
  clientOrderId: string
  resolution: "FILLED" | "REJECTED" | "STILL_OPEN" | "UNRESOLVED"
}>

/**
 * Resolves submissions that have no terminal event when explicitly invoked.
 *
 * This is what makes a crash between the submission record and the broker
 * response recoverable: the order is looked up by client order id and closed
 * out from what the broker actually holds. An aged submission the broker
 * confirms absent resolves to `SUBMISSION_ABANDONED`; it is never resubmitted.
 */
export async function reconcileOpenOrderRecordsV1({
  store,
  submitter,
  signal,
  idFactory = randomUUID,
  now = () => new Date(),
  maxOrders = 100,
  notFoundGraceMs = 15 * 60_000,
}: ReconcileOpenOrdersOptions): Promise<readonly ReconciledOrderRecord[]> {
  signal.throwIfAborted()
  if (!Number.isSafeInteger(notFoundGraceMs) || notFoundGraceMs < 0) {
    throw new Error("notFoundGraceMs must be a non-negative safe integer")
  }
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
    signal.throwIfAborted()
    if (observed.status === "LOOKUP_UNKNOWN") {
      reconciled.push({ cycleId, clientOrderId, resolution: "UNRESOLVED" })
      continue
    }
    if (observed.status === "FOUND" && observed.order.status === "OPEN") {
      reconciled.push({ cycleId, clientOrderId, resolution: "STILL_OPEN" })
      continue
    }

    const observedAt = now()
    if (
      observed.status === "CONFIRMED_NOT_FOUND" &&
      observedAt.getTime() - Date.parse(submission.occurredAt) < notFoundGraceMs
    ) {
      reconciled.push({ cycleId, clientOrderId, resolution: "UNRESOLVED" })
      continue
    }

    const envelope = {
      eventId: idFactory(),
      eventVersion: LEDGER_EVENT_VERSION,
      occurredAt: isoTimestamp(observedAt),
      correlationId: submission.correlationId,
      causationEventId: submission.eventId,
      cycleId,
      ...(submission.sessionId === undefined
        ? {}
        : { sessionId: submission.sessionId }),
    }

    if (observed.status === "FOUND" && observed.order.status === "FILLED") {
      const order = observed.order
      await store.append(
        {
          ...envelope,
          eventType: "ORDER_FILLED",
          payload: {
            submissionVersion: ORDER_SUBMISSION_VERSION,
            clientOrderId,
            brokerOrderId: order.brokerOrderId,
            filledQuantity: order.filledQuantity,
            ...(order.filledAvgPriceCentsPerShare === undefined
              ? {}
              : {
                  filledAvgPriceCentsPerShare:
                    order.filledAvgPriceCentsPerShare,
                }),
            brokerTimestamp: order.brokerTimestamp,
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
          ...(observed.status === "FOUND" &&
          observed.order.status === "REJECTED" &&
          observed.order.brokerOrderId
            ? { brokerOrderId: observed.order.brokerOrderId }
            : {}),
          reason:
            observed.status === "FOUND" && observed.order.status === "REJECTED"
              ? observed.order.reason
              : "SUBMISSION_ABANDONED",
          observedAt: isoTimestamp(observedAt),
        },
      },
      signal,
    )
    reconciled.push({ cycleId, clientOrderId, resolution: "REJECTED" })
  }

  return reconciled
}
