import { describe, expect, it, vi } from "vitest"

import type { TradeIntentV4 } from "../src/contracts/trade-intent-v4.js"
import {
  deriveExecutionAuthorizationV1,
  resolveExecutionAuthorizationV1,
} from "../src/execution/authorization-v1.js"
import type {
  LedgerEventV4,
  StoredLedgerEventV4,
} from "../src/event-ledger/ledger-event-v1.js"
import type { LedgerStore } from "../src/event-ledger/ledger-store.js"
import { createResearchLifecycleRecorder } from "../src/event-ledger/research-lifecycle-recorder.js"
import { createSqliteLedgerStore } from "../src/event-ledger/sqlite-ledger-store.js"
import type { ResearchCycleTerminalRecordV4 } from "../src/research/cycle/outcome.js"
import type { ShadowRiskDecisionV1 } from "../src/risk/shadow-risk-v1.js"

const ISSUED_AT = "2026-09-01T14:00:00.000Z"
const EXPIRES_AT = "2026-09-01T14:10:00.000Z"
const AUTHORIZATION_ID = "cycle-authorization-1"
const signal = new AbortController().signal

const intent: TradeIntentV4 = {
  contractVersion: "4.0.0",
  decisionContractVersion: "4.0.0",
  underlying: "SPY",
  direction: "BULLISH",
  strategy: "BULL_CALL_SPREAD",
  quoteSnapshotRef: "alpaca-risk-quotes-SPY",
  evaluatedAt: ISSUED_AT,
  legs: [
    {
      contractSymbol: "SPY260918C00650000",
      positionIntent: "BUY_TO_OPEN",
      ratioQuantity: 1,
      quote: {
        contractSymbol: "SPY260918C00650000",
        feed: "INDICATIVE",
        bidCentsPerShare: 220,
        askCentsPerShare: 223,
        providerTimestamp: "2026-09-01T13:59:30.000000000Z",
      },
    },
    {
      contractSymbol: "SPY260918C00655000",
      positionIntent: "SELL_TO_OPEN",
      ratioQuantity: 1,
      quote: {
        contractSymbol: "SPY260918C00655000",
        feed: "INDICATIVE",
        bidCentsPerShare: 120,
        askCentsPerShare: 123,
        providerTimestamp: "2026-09-01T13:59:31.000000000Z",
      },
    },
  ],
  premiumEffect: "DEBIT",
  entryLimitCentsPerStrategyUnit: 103,
}

const riskDecision: ShadowRiskDecisionV1 = {
  decisionVersion: "1.0.0",
  mode: "SHADOW",
  evaluationVersion: "1.0.0",
  ruleVersion: "2.0.0",
  stage: "EVALUATED",
  outcome: "APPROVED",
  evaluatedIntent: intent,
  stateProvenance: {
    capturedAt: ISSUED_AT,
    accountObservedAt: ISSUED_AT,
    portfolioObservedAt: ISSUED_AT,
    contractsObservedAt: ISSUED_AT,
    quoteSnapshot: {
      provider: "ALPACA",
      source: "options-snapshots-indicative",
      retrievedAt: ISSUED_AT,
      freshUntil: EXPIRES_AT,
    },
    reconciliationReasonCodes: [],
  },
  evaluation: {
    evaluationVersion: "1.0.0",
    ruleVersion: "2.0.0",
    outcome: "APPROVED",
    evaluatedAt: ISSUED_AT,
    approvedQuantity: 1,
    maxLossCents: 10_300,
    projectedBuyingPowerCents: 989_700,
  },
}

const authorization = deriveExecutionAuthorizationV1({
  authorizationId: AUTHORIZATION_ID,
  issuedAt: ISSUED_AT,
  expiresAt: EXPIRES_AT,
  riskDecision,
})!

const startEvent: LedgerEventV4 = {
  eventId: "event-start",
  eventVersion: "4.0.0",
  eventType: "RESEARCH_CYCLE_STARTED",
  occurredAt: ISSUED_AT,
  correlationId: "correlation-1",
  cycleId: AUTHORIZATION_ID,
  sessionId: "session-1",
  payload: { cycleNumber: 1 },
}
const intentEvent: LedgerEventV4 = {
  ...startEvent,
  eventId: "event-intent",
  eventType: "TRADE_INTENT_DERIVED",
  causationEventId: startEvent.eventId,
  payload: { intent },
}
const riskEvent: LedgerEventV4 = {
  ...startEvent,
  eventId: "event-risk",
  eventType: "RISK_SHADOW_DECISION_RECORDED",
  causationEventId: intentEvent.eventId,
  payload: { decision: riskDecision },
}
const authorizationEvent: LedgerEventV4 = {
  ...startEvent,
  eventId: "event-authorization",
  eventType: "EXECUTION_AUTHORIZATION_RECORDED",
  causationEventId: riskEvent.eventId,
  payload: { instruction: authorization },
}

describe("execution authorization", () => {
  it("derives the exact positive-debit Alpaca paper MLeg instruction", () => {
    expect(authorization).toMatchObject({
      authorizationVersion: "1.0.0",
      authorizationId: AUTHORIZATION_ID,
      account: "ALPACA_PAPER",
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      order: {
        qty: "1",
        type: "limit",
        time_in_force: "day",
        limit_price: "1.03",
        order_class: "mleg",
        legs: [
          {
            symbol: "SPY260918C00650000",
            ratio_qty: "1",
            side: "buy",
            position_intent: "buy_to_open",
          },
          {
            symbol: "SPY260918C00655000",
            ratio_qty: "1",
            side: "sell",
            position_intent: "sell_to_open",
          },
        ],
      },
    })
    expect(authorization.order.client_order_id).toMatch(/^gitl-[a-f0-9]{32}$/u)
  })

  it("does not derive from rejected, expired, single-leg, or credit risk", () => {
    expect(deriveExecutionAuthorizationV1({
      authorizationId: AUTHORIZATION_ID,
      issuedAt: EXPIRES_AT,
      expiresAt: ISSUED_AT,
      riskDecision,
    })).toBeUndefined()
    expect(deriveExecutionAuthorizationV1({
      authorizationId: AUTHORIZATION_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      riskDecision: { ...riskDecision, outcome: "REJECTED" },
    })).toBeUndefined()
    expect(deriveExecutionAuthorizationV1({
      authorizationId: AUTHORIZATION_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      riskDecision: {
        ...riskDecision,
        evaluatedIntent: { ...intent, legs: [intent.legs[0]!] },
      },
    })).toBeUndefined()
    expect(deriveExecutionAuthorizationV1({
      authorizationId: AUTHORIZATION_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      riskDecision: {
        ...riskDecision,
        evaluatedIntent: { ...intent, premiumEffect: "CREDIT" },
      },
    })).toBeUndefined()
  })

  it("resolves the immutable event against its approved risk cause", async () => {
    const store = createSqliteLedgerStore({
      path: ":memory:",
      knownCredentialValues: [],
    })
    await store.migrate()
    await store.appendBatch([
      startEvent,
      intentEvent,
      riskEvent,
      authorizationEvent,
    ])

    await expect(resolveExecutionAuthorizationV1(
      store,
      AUTHORIZATION_ID,
      new Date("2026-09-01T14:01:00.000Z"),
    )).resolves.toMatchObject({
      status: "AUTHORIZED",
      eventId: authorizationEvent.eventId,
      authorization,
    })
    await expect(resolveExecutionAuthorizationV1(
      store,
      AUTHORIZATION_ID,
      new Date(EXPIRES_AT),
    )).resolves.toEqual({
      status: "NOT_AUTHORIZED",
      reasonCodes: ["AUTHORIZATION_NOT_ACTIVE"],
    })
    await store.close()
  })

  it("allows one durable trader result after the authorized cycle completes", async () => {
    const store = createSqliteLedgerStore({
      path: ":memory:",
      knownCredentialValues: [],
    })
    await store.migrate()
    const completed: LedgerEventV4 = {
      ...startEvent,
      eventId: "event-completed",
      eventType: "RESEARCH_CYCLE_COMPLETED",
      causationEventId: authorizationEvent.eventId,
      payload: { status: "PORTFOLIO_EVALUATED" },
    }
    const result: LedgerEventV4 = {
      ...startEvent,
      eventId: "event-result",
      eventType: "PAPER_TRADER_RESULT_RECORDED",
      occurredAt: "2026-09-01T14:01:00.000Z",
      causationEventId: authorizationEvent.eventId,
      payload: {
        result: {
          resultVersion: "1.0.0",
          status: "NOT_SUBMITTED",
          authorizationId: AUTHORIZATION_ID,
          clientOrderId: authorization.order.client_order_id,
          observedAt: "2026-09-01T14:01:00.000Z",
          reasonCodes: ["MARKET_CLOSED"],
        },
      },
    }
    await store.appendBatch([
      startEvent,
      intentEvent,
      riskEvent,
      authorizationEvent,
      completed,
    ])

    await expect(store.append(result)).resolves.toMatchObject({
      eventType: "PAPER_TRADER_RESULT_RECORDED",
    })
    await expect(store.append({
      ...result,
      eventId: "event-result-2",
    })).rejects.toThrow()
    await store.close()
  })

  it("records authorization only for a standard selected proposal", async () => {
    const record = async (cycleMode: "STANDARD" | "DRY_RUN") => {
      const events: LedgerEventV4[] = []
      const asStored = (event: LedgerEventV4): StoredLedgerEventV4 => ({
        ...event,
        sequence: events.length,
        recordedAt: ISSUED_AT,
      }) as StoredLedgerEventV4
      const store: LedgerStore = {
        migrate: vi.fn(async () => undefined),
        append: vi.fn(async (event) => {
          events.push(event)
          return asStored(event)
        }),
        appendBatch: vi.fn(async (batch) => {
          events.push(...batch)
          return batch.map(asStored)
        }),
        getByEventId: vi.fn(async () => undefined),
        list: vi.fn(async () => []),
        close: vi.fn(async () => undefined),
      }
      let id = 0
      const recorder = createResearchLifecycleRecorder({
        store,
        idFactory: () => `generated-${++id}`,
        now: () => new Date(ISSUED_AT),
      })
      const cycle = await recorder.startCycle({
        sessionId: "session-1",
        cycleNumber: 1,
        sessionDate: "2026-09-01",
        initialEligibility: {
          evaluatedAt: ISSUED_AT,
          sessionDate: "2026-09-01",
          sessionOpen: "2026-09-01T13:30:00.000Z",
          sessionClose: "2026-09-01T20:00:00.000Z",
          researchEligible: true,
          tradeIntentEligible: true,
          tradeIntentWindow: {
            slotStartedAt: ISSUED_AT,
            deadline: EXPIRES_AT,
          },
          ...(cycleMode === "DRY_RUN" ? { researchMode: "DRY_RUN" as const } : {}),
        },
        signal,
      })
      const terminalRecord = {
        researchInvocation: {
          invocationVersion: "7.0.0",
          agentName: "research",
          cycleMode,
          promptVersion: "7.0.0",
          decisionContractVersion: "4.0.0",
          reportVersion: "7.0.0",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          responseError: false,
          tokens: {},
          tools: {
            totalCount: 0,
            errorCount: 0,
            incompleteCount: 0,
            omittedCount: 0,
            calls: [],
          },
        },
        symbolScreen: {
          screenVersion: "2.0.0",
          policyVersion: "3.0.0",
          mode: "SHADOW",
          evaluatedAt: ISSUED_AT,
          universeSnapshotId: `option-universe-v2-${"a".repeat(64)}`,
          symbols: [],
        },
        evidenceSnapshots: [],
        outcome: {
          outcomeVersion: "4.0.0",
          status: "PORTFOLIO_EVALUATED",
          decision: { contractVersion: "4.0.0", outcome: "PROPOSE_TRADES" },
          proposals: [{
            priority: 1,
            underlying: "SPY",
            status: "RISK_EVALUATED",
            proposal: {},
            intent,
            shadowRisk: { decision: riskDecision, breakerTransitions: [] },
            selected: true,
          }],
        },
      } as unknown as ResearchCycleTerminalRecordV4
      await cycle.outcomeSink.record(terminalRecord, signal)
      return events
    }

    expect((await record("STANDARD")).map(({ eventType }) => eventType)).toContain(
      "EXECUTION_AUTHORIZATION_RECORDED",
    )
    expect((await record("DRY_RUN")).map(({ eventType }) => eventType)).not.toContain(
      "EXECUTION_AUTHORIZATION_RECORDED",
    )
  })
})
