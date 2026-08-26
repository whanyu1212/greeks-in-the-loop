import { describe, expect, it } from "vitest"

import {
  ledgerEventV1Schema,
  LEDGER_EVENT_TYPES,
  type LedgerEventV1,
} from "../src/event-ledger/ledger-event-v1.js"

const baseEvent = {
  eventId: "event-1",
  eventVersion: "1.0.0",
  eventType: "RESEARCH_CYCLE_STARTED",
  occurredAt: "2026-08-25T14:30:00.000Z",
  correlationId: "correlation-1",
  cycleId: "cycle-1",
  sessionId: "ses_example",
  payload: {
    cycleNumber: 1,
  },
} as const

describe("LedgerEventV1", () => {
  it("accepts a versioned research-cycle event", () => {
    expect(ledgerEventV1Schema.parse(baseEvent)).toEqual(baseEvent)
  })

  it("defines only current research-to-intent event types", () => {
    expect(LEDGER_EVENT_TYPES).toEqual([
      "OPENCODE_SESSION_STARTED",
      "RESEARCH_CYCLE_STARTED",
      "EVIDENCE_SNAPSHOT_REFERENCED",
      "PRELIMINARY_RESEARCH_RECORDED",
      "RESEARCH_REPORT_RECORDED",
      "RESEARCH_DECISION_VALIDATED",
      "RESEARCH_DECISION_REJECTED",
      "TRADE_INTENT_DERIVED",
      "TRADE_INTENT_DERIVATION_REJECTED",
      "RESEARCH_CYCLE_COMPLETED",
      "RESEARCH_CYCLE_INTERRUPTED",
    ])
  })

  it("rejects a payload that does not match its event type", () => {
    const invalidEvent: LedgerEventV1 = {
      ...baseEvent,
      // @ts-expect-error The event type and payload must remain paired statically.
      payload: { status: "VALIDATED_NO_ACTION" },
    }

    expect(
      ledgerEventV1Schema.safeParse(invalidEvent).success,
    ).toBe(false)
  })

  it("rejects imprecise timestamps and unknown fields", () => {
    expect(
      ledgerEventV1Schema.safeParse({
        ...baseEvent,
        occurredAt: "2026-08-25T14:30:00Z",
      }).success,
    ).toBe(false)
    expect(
      ledgerEventV1Schema.safeParse({
        ...baseEvent,
        rawResponse: "untrusted",
      }).success,
    ).toBe(false)
  })

  it("uses occurredAt as the canonical event occurrence time", () => {
    expect(
      ledgerEventV1Schema.safeParse({
        ...baseEvent,
        payload: {
          ...baseEvent.payload,
          startedAt: "2026-08-25T14:31:00.000Z",
        },
      }).success,
    ).toBe(false)
  })

  it("requires cycle identity and rejects self-causation", () => {
    expect(
      ledgerEventV1Schema.safeParse({
        ...baseEvent,
        cycleId: undefined,
      }).success,
    ).toBe(false)
    expect(
      ledgerEventV1Schema.safeParse({
        ...baseEvent,
        causationEventId: baseEvent.eventId,
      }).success,
    ).toBe(false)
  })

  it("requires matching session-start identity", () => {
    const sessionEvent = {
      eventId: "event-session",
      eventVersion: "1.0.0",
      eventType: "OPENCODE_SESSION_STARTED",
      occurredAt: "2026-08-25T14:29:00.000Z",
      correlationId: "session-correlation",
      sessionId: "ses_envelope",
      payload: {
        sessionId: "ses_payload",
      },
    }

    expect(ledgerEventV1Schema.safeParse(sessionEvent).success).toBe(false)
    expect(
      ledgerEventV1Schema.safeParse({
        ...sessionEvent,
        sessionId: "ses_payload",
      }).success,
    ).toBe(true)
  })

  it("rejects evidence freshness ending before retrieval", () => {
    expect(
      ledgerEventV1Schema.safeParse({
        ...baseEvent,
        eventType: "EVIDENCE_SNAPSHOT_REFERENCED",
        payload: {
          snapshotRef: "snapshot-1",
          provider: "ALPACA",
          source: "option-quotes",
          retrievedAt: "2026-08-25T14:30:01.000Z",
          freshUntil: "2026-08-25T14:30:00.000Z",
        },
      }).success,
    ).toBe(false)
  })

  it("rejects speculative broker event types", () => {
    expect(
      ledgerEventV1Schema.safeParse({
        ...baseEvent,
        eventType: "ORDER_SUBMITTED",
      }).success,
    ).toBe(false)
  })
})
