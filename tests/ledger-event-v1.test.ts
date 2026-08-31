import { describe, expect, it } from "vitest"

import { canonicalJsonSha256 } from "../src/shared/canonical-json.js"
import {
  ledgerEventV2Schema,
  LEDGER_EVENT_TYPES,
  type LedgerEventV2,
} from "../src/event-ledger/ledger-event-v1.js"

const baseEvent = {
  eventId: "event-1",
  eventVersion: "2.0.0",
  eventType: "RESEARCH_CYCLE_STARTED",
  occurredAt: "2026-08-25T14:30:00.000Z",
  correlationId: "correlation-1",
  cycleId: "cycle-1",
  sessionId: "ses_example",
  payload: {
    cycleNumber: 1,
  },
} as const

describe("LedgerEventV2", () => {
  it("accepts a versioned research-cycle event", () => {
    expect(ledgerEventV2Schema.parse(baseEvent)).toEqual(baseEvent)
  })

  it("preserves the canonical V2 ledger-event bytes", () => {
    expect(canonicalJsonSha256(ledgerEventV2Schema.parse(baseEvent))).toBe(
      "11a5c93ea34cc7d42f348d21997c004195ec22896b872e39acf009e363b0e255",
    )
  })

  it("defines only current research and shadow-risk event types", () => {
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
      "RESEARCH_INVOCATION_IDENTITY_REJECTED",
      "RESEARCH_LOOP_BREAKER_LATCHED",
      "RESEARCH_LOOP_BREAKER_RESET",
      "RISK_SHADOW_DECISION_RECORDED",
      "RISK_BREAKER_LATCHED",
    ])
  })

  it("accepts strict cycleless research-loop breaker transitions", () => {
    const envelope = {
      eventId: "breaker-event-1",
      eventVersion: "2.0.0",
      occurredAt: "2026-08-25T14:30:00.000Z",
      correlationId: "breaker-correlation-1",
    } as const
    expect(
      ledgerEventV2Schema.parse({
        ...envelope,
        eventType: "RESEARCH_LOOP_BREAKER_LATCHED",
        payload: {
          stateVersion: "1.0.0",
          reason: "CONSECUTIVE_FAILURE_LIMIT",
          consecutiveFailures: 5,
          threshold: 5,
          lastAttempt: 9,
        },
      }),
    ).toMatchObject({ eventType: "RESEARCH_LOOP_BREAKER_LATCHED" })
    expect(
      ledgerEventV2Schema.parse({
        ...envelope,
        eventId: "breaker-event-2",
        eventType: "RESEARCH_LOOP_BREAKER_RESET",
        payload: {
          stateVersion: "1.0.0",
          reason: "OPERATOR_REQUESTED",
        },
      }),
    ).toMatchObject({ eventType: "RESEARCH_LOOP_BREAKER_RESET" })
  })

  it("requires cycle identity on invocation-identity rejections", () => {
    const cycleScoped = {
      eventId: "identity-event-1",
      eventVersion: "2.0.0",
      eventType: "RESEARCH_INVOCATION_IDENTITY_REJECTED",
      occurredAt: "2026-08-25T14:30:00.000Z",
      correlationId: "identity-correlation-1",
      causationEventId: "cycle-start-1",
      cycleId: "cycle-1",
      sessionId: "session-1",
      payload: {
        invocationVersion: "3.0.0",
        reason: "MODEL_DRIFT",
        expected: "gpt-5.6-sol",
        observed: "gpt-5.6-sol-fast",
      },
    } as const
    expect(ledgerEventV2Schema.parse(cycleScoped)).toMatchObject({
      eventType: "RESEARCH_INVOCATION_IDENTITY_REJECTED",
    })
    expect(
      ledgerEventV2Schema.parse({
        ...cycleScoped,
        payload: { ...cycleScoped.payload, invocationVersion: "3.0.0" },
      }),
    ).toMatchObject({
      payload: { invocationVersion: "3.0.0" },
    })

    // Unlike the breaker events, drift happens inside a live cycle.
    const { cycleId, sessionId, ...cycleless } = cycleScoped
    expect(() => ledgerEventV2Schema.parse(cycleless)).toThrow()

    // Bounded payload only: no raw provider prose, no extra fields.
    expect(() =>
      ledgerEventV2Schema.parse({
        ...cycleScoped,
        payload: { ...cycleScoped.payload, providerResponse: "..." },
      }),
    ).toThrow()
    expect(() =>
      ledgerEventV2Schema.parse({
        ...cycleScoped,
        payload: { ...cycleScoped.payload, reason: "SOMETHING_ELSE" },
      }),
    ).toThrow()
    expect(() =>
      ledgerEventV2Schema.parse({
        ...cycleScoped,
        payload: { ...cycleScoped.payload, observed: "a b c" },
      }),
    ).toThrow()
  })

  it("rejects malformed or cycle-scoped research-loop breaker events", () => {
    const latch = {
      eventId: "breaker-event-1",
      eventVersion: "2.0.0",
      eventType: "RESEARCH_LOOP_BREAKER_LATCHED",
      occurredAt: "2026-08-25T14:30:00.000Z",
      correlationId: "breaker-correlation-1",
      payload: {
        stateVersion: "1.0.0",
        reason: "CONSECUTIVE_FAILURE_LIMIT",
        consecutiveFailures: 5,
        threshold: 5,
        lastAttempt: 9,
      },
    } as const

    for (const invalid of [
      { ...latch, cycleId: "cycle-1" },
      { ...latch, sessionId: "session-1" },
      { ...latch, causationEventId: "event-0" },
      { ...latch, payload: { ...latch.payload, consecutiveFailures: 4 } },
      { ...latch, payload: { ...latch.payload, rawError: "secret" } },
      { ...latch, payload: { ...latch.payload, stateVersion: "2.0.0" } },
    ]) {
      expect(ledgerEventV2Schema.safeParse(invalid).success).toBe(false)
    }
  })

  it("rejects a payload that does not match its event type", () => {
    const invalidEvent: LedgerEventV2 = {
      ...baseEvent,
      // @ts-expect-error The event type and payload must remain paired statically.
      payload: { status: "VALIDATED_NO_ACTION" },
    }

    expect(
      ledgerEventV2Schema.safeParse(invalidEvent).success,
    ).toBe(false)
  })

  it("rejects imprecise timestamps and unknown fields", () => {
    expect(
      ledgerEventV2Schema.safeParse({
        ...baseEvent,
        occurredAt: "2026-08-25T14:30:00Z",
      }).success,
    ).toBe(false)
    expect(
      ledgerEventV2Schema.safeParse({
        ...baseEvent,
        rawResponse: "untrusted",
      }).success,
    ).toBe(false)
  })

  it("uses occurredAt as the canonical event occurrence time", () => {
    expect(
      ledgerEventV2Schema.safeParse({
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
      ledgerEventV2Schema.safeParse({
        ...baseEvent,
        cycleId: undefined,
      }).success,
    ).toBe(false)
    expect(
      ledgerEventV2Schema.safeParse({
        ...baseEvent,
        causationEventId: baseEvent.eventId,
      }).success,
    ).toBe(false)
  })

  it("requires matching session-start identity", () => {
    const sessionEvent = {
      eventId: "event-session",
      eventVersion: "2.0.0",
      eventType: "OPENCODE_SESSION_STARTED",
      occurredAt: "2026-08-25T14:29:00.000Z",
      correlationId: "session-correlation",
      sessionId: "ses_envelope",
      payload: {
        sessionId: "ses_payload",
      },
    }

    expect(ledgerEventV2Schema.safeParse(sessionEvent).success).toBe(false)
    expect(
      ledgerEventV2Schema.safeParse({
        ...sessionEvent,
        sessionId: "ses_payload",
      }).success,
    ).toBe(true)
  })

  it("rejects evidence freshness ending before retrieval", () => {
    expect(
      ledgerEventV2Schema.safeParse({
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
      ledgerEventV2Schema.safeParse({
        ...baseEvent,
        eventType: "ORDER_SUBMITTED",
      }).success,
    ).toBe(false)
  })
})
