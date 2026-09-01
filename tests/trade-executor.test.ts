import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { TradeIntentV4 } from "../src/contracts/trade-intent-v4.js"
import type { LedgerEventV4 } from "../src/event-ledger/ledger-event-v1.js"
import type { LedgerStore } from "../src/event-ledger/ledger-store.js"
import { createSqliteLedgerStore } from "../src/event-ledger/deprecated/sqlite-ledger-store.js"
import type { ShadowRiskResultV1 } from "../src/risk/shadow-risk-v1.js"
import type {
  BrokerOrderOutcome,
  OrderSubmitter,
} from "../src/execution/alpaca-order-submitter.js"
import {
  buildAlpacaMlegOrderRequestV1,
  createOrderSubmittedPayloadV1,
} from "../src/execution/order-submission-v1.js"
import {
  executeApprovedTradeV1,
  hasHeldExecutedEntryV1,
  reconcileOpenOrderRecordsV1,
} from "../src/execution/trade-executor.js"

const TIMESTAMP = "2026-08-26T10:00:00.000Z"
const temporaryDirectories: string[] = []

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { force: true, recursive: true })
  }
})

const intent: TradeIntentV4 = {
  contractVersion: "4.0.0",
  decisionContractVersion: "4.0.0",
  underlying: "SPY",
  direction: "BULLISH",
  strategy: "BULL_CALL_SPREAD",
  quoteSnapshotRef: "snapshot-1",
  evaluatedAt: TIMESTAMP,
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
        providerTimestamp: "2026-08-26T09:59:30.000000000Z",
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
        askCentsPerShare: 121,
        providerTimestamp: "2026-08-26T09:59:31.000000000Z",
      },
    },
  ],
  premiumEffect: "DEBIT",
  entryLimitCentsPerStrategyUnit: 103,
}

const approvedShadowRisk: ShadowRiskResultV1 = {
  decision: {
    decisionVersion: "1.0.0",
    mode: "SHADOW",
    evaluationVersion: "1.0.0",
    ruleVersion: "2.0.0",
    stage: "EVALUATED",
    outcome: "APPROVED",
    evaluatedIntent: intent,
    stateProvenance: {
      capturedAt: TIMESTAMP,
      accountObservedAt: TIMESTAMP,
      portfolioObservedAt: TIMESTAMP,
      contractsObservedAt: TIMESTAMP,
      quoteSnapshot: {
        provider: "ALPACA",
        source: "alpaca-shadow-risk-quotes-v1",
        retrievedAt: TIMESTAMP,
        freshUntil: "2026-08-26T10:01:00.000Z",
      },
      reconciliationReasonCodes: [],
    },
    evaluation: {
      evaluationVersion: "1.0.0",
      ruleVersion: "2.0.0",
      outcome: "APPROVED",
      evaluatedAt: TIMESTAMP,
      approvedQuantity: 1,
      maxLossCents: 10_100,
      projectedBuyingPowerCents: 9_989_900,
    },
  },
  breakerTransitions: [],
}

const rejectedShadowRisk: ShadowRiskResultV1 = {
  decision: {
    ...(approvedShadowRisk.decision as Extract<
      ShadowRiskResultV1["decision"],
      { stage: "EVALUATED" }
    >),
    outcome: "REJECTED",
    evaluation: {
      evaluationVersion: "1.0.0",
      ruleVersion: "2.0.0",
      outcome: "REJECTED",
      evaluatedAt: TIMESTAMP,
      reasonCodes: ["EXPOSURE_LIMIT_ACTIVE"],
    },
  },
} as ShadowRiskResultV1

const createStore = async () => {
  const directory = mkdtempSync(join(tmpdir(), "trade-executor-test-"))
  temporaryDirectories.push(directory)
  const store = createSqliteLedgerStore({
    path: join(directory, "ledger.sqlite"),
    knownCredentialValues: [],
  })
  await store.migrate()
  return store
}

/** Seeds the durable prefix an execution requires: intent, then risk decision. */
const seedApprovedCycle = async (
  store: LedgerStore,
  outcome: "APPROVED" | "REJECTED" = "APPROVED",
) => {
  const events: LedgerEventV4[] = [
    {
      eventId: "cycle-start-1",
      eventVersion: "4.0.0",
      eventType: "RESEARCH_CYCLE_STARTED",
      occurredAt: TIMESTAMP,
      correlationId: "correlation-1",
      cycleId: "cycle-1",
      sessionId: "ses_example",
      payload: { cycleNumber: 1 },
    },
    {
      eventId: "intent-1",
      eventVersion: "4.0.0",
      eventType: "TRADE_INTENT_DERIVED",
      occurredAt: TIMESTAMP,
      correlationId: "correlation-1",
      causationEventId: "cycle-start-1",
      cycleId: "cycle-1",
      sessionId: "ses_example",
      payload: { intent },
    },
    {
      eventId: "risk-1",
      eventVersion: "4.0.0",
      eventType: "RISK_SHADOW_DECISION_RECORDED",
      occurredAt: TIMESTAMP,
      correlationId: "correlation-1",
      causationEventId: "intent-1",
      cycleId: "cycle-1",
      sessionId: "ses_example",
      payload: {
        decision:
          outcome === "APPROVED"
            ? approvedShadowRisk.decision
            : rejectedShadowRisk.decision,
      },
    },
  ] as LedgerEventV4[]
  await store.appendBatch(events)
}

const stubSubmitter = (
  outcome: BrokerOrderOutcome,
  calls: string[] = [],
): OrderSubmitter => ({
  async submit({ clientOrderId }) {
    calls.push(`submit:${clientOrderId}`)
    return outcome
  },
  async lookup({ clientOrderId }) {
    calls.push(`lookup:${clientOrderId}`)
    return outcome.status === "REJECTED" && outcome.brokerOrderId === undefined
      ? undefined
      : outcome
  },
})

const eventTypes = async (store: LedgerStore) =>
  (await store.list({ cycleId: "cycle-1", direction: "ASC", limit: 50 })).map(
    ({ eventType }) => eventType,
  )

describe("buildAlpacaMlegOrderRequestV1", () => {
  it("opens both legs of a debit vertical at the approved net limit", () => {
    expect(buildAlpacaMlegOrderRequestV1(intent, "cycle-1")).toEqual({
      order_class: "mleg",
      qty: "1",
      type: "limit",
      time_in_force: "day",
      limit_price: "1.03",
      client_order_id: "cycle-1",
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
    })
  })

  it("records the approving rule version with the submission", () => {
    expect(
      createOrderSubmittedPayloadV1(intent, "cycle-1", "2.0.0", 10_100),
    ).toMatchObject({
      clientOrderId: "cycle-1",
      ruleVersion: "2.0.0",
      quantity: 1,
      limitPriceCentsPerStrategyUnit: 103,
      maxLossCents: 10_100,
      timeInForce: "day",
    })
  })
})

describe("executeApprovedTradeV1", () => {
  it("submits an approved intent and records the fill", async () => {
    const store = await createStore()
    await seedApprovedCycle(store)
    const calls: string[] = []

    const result = await executeApprovedTradeV1({
      store,
      submitter: stubSubmitter(
        {
          status: "FILLED",
          brokerOrderId: "broker-1",
          filledQuantity: 1,
          filledAvgPriceCentsPerShare: 100,
          brokerTimestamp: TIMESTAMP,
        },
        calls,
      ),
      shadowRisk: approvedShadowRisk,
      cycleId: "cycle-1",
      signal: AbortSignal.timeout(5_000),
    })

    expect(result).toEqual({
      status: "FILLED",
      brokerOrderId: "broker-1",
      clientOrderId: "cycle-1",
    })
    expect(calls).toEqual(["submit:cycle-1"])
    expect(await eventTypes(store)).toEqual([
      "RESEARCH_CYCLE_STARTED",
      "TRADE_INTENT_DERIVED",
      "RISK_SHADOW_DECISION_RECORDED",
      "ORDER_SUBMITTED",
      "ORDER_FILLED",
    ])
    await store.close()
  })

  it("never reaches the broker when risk did not approve", async () => {
    const store = await createStore()
    await seedApprovedCycle(store, "REJECTED")
    const calls: string[] = []

    const result = await executeApprovedTradeV1({
      store,
      submitter: stubSubmitter(
        {
          status: "FILLED",
          brokerOrderId: "broker-1",
          filledQuantity: 1,
          brokerTimestamp: TIMESTAMP,
        },
        calls,
      ),
      shadowRisk: rejectedShadowRisk,
      cycleId: "cycle-1",
      signal: AbortSignal.timeout(5_000),
    })

    expect(result).toEqual({ status: "SKIPPED", reason: "RISK_NOT_APPROVED" })
    expect(calls).toEqual([])
    expect(await eventTypes(store)).not.toContain("ORDER_SUBMITTED")
    await store.close()
  })

  it("refuses to submit when the approval was never persisted", async () => {
    const store = await createStore()
    const calls: string[] = []

    const result = await executeApprovedTradeV1({
      store,
      submitter: stubSubmitter(
        {
          status: "FILLED",
          brokerOrderId: "broker-1",
          filledQuantity: 1,
          brokerTimestamp: TIMESTAMP,
        },
        calls,
      ),
      shadowRisk: approvedShadowRisk,
      cycleId: "cycle-1",
      signal: AbortSignal.timeout(5_000),
    })

    expect(result).toEqual({ status: "SKIPPED", reason: "APPROVAL_NOT_RECORDED" })
    expect(calls).toEqual([])
    await store.close()
  })

  it("submits at most once per cycle even when run twice", async () => {
    const store = await createStore()
    await seedApprovedCycle(store)
    const calls: string[] = []
    const submitter = stubSubmitter(
      {
        status: "FILLED",
        brokerOrderId: "broker-1",
        filledQuantity: 1,
        brokerTimestamp: TIMESTAMP,
      },
      calls,
    )
    const run = () =>
      executeApprovedTradeV1({
        store,
        submitter,
        shadowRisk: approvedShadowRisk,
        cycleId: "cycle-1",
        signal: AbortSignal.timeout(5_000),
      })

    await run()
    expect(await run()).toEqual({
      status: "SKIPPED",
      reason: "ALREADY_SUBMITTED",
    })
    expect(calls).toEqual(["submit:cycle-1"])
    expect(
      (await eventTypes(store)).filter((type) => type === "ORDER_SUBMITTED"),
    ).toHaveLength(1)
    await store.close()
  })

  it("records a broker rejection without a fill", async () => {
    const store = await createStore()
    await seedApprovedCycle(store)

    const result = await executeApprovedTradeV1({
      store,
      submitter: stubSubmitter({
        status: "REJECTED",
        brokerOrderId: "broker-1",
        reason: "BROKER_REJECTED",
      }),
      shadowRisk: approvedShadowRisk,
      cycleId: "cycle-1",
      signal: AbortSignal.timeout(5_000),
    })

    expect(result).toMatchObject({ status: "REJECTED", reason: "BROKER_REJECTED" })
    expect(await eventTypes(store)).toContain("ORDER_REJECTED")
    expect(await eventTypes(store)).not.toContain("ORDER_FILLED")
    await store.close()
  })

  it("leaves a working order open for reconciliation", async () => {
    const store = await createStore()
    await seedApprovedCycle(store)

    const result = await executeApprovedTradeV1({
      store,
      submitter: stubSubmitter({
        status: "OPEN",
        brokerOrderId: "broker-1",
        brokerStatus: "new",
      }),
      shadowRisk: approvedShadowRisk,
      cycleId: "cycle-1",
      signal: AbortSignal.timeout(5_000),
    })

    expect(result).toMatchObject({ status: "OPEN" })
    const types = await eventTypes(store)
    expect(types).toContain("ORDER_SUBMITTED")
    expect(types).not.toContain("ORDER_FILLED")
    expect(types).not.toContain("ORDER_REJECTED")
    await store.close()
  })
})

describe("ledger execution invariants", () => {
  it("rejects an order that did not follow an approved risk decision", async () => {
    const store = await createStore()
    await seedApprovedCycle(store, "REJECTED")

    await expect(
      store.append({
        eventId: "order-1",
        eventVersion: "4.0.0",
        eventType: "ORDER_SUBMITTED",
        occurredAt: TIMESTAMP,
        correlationId: "correlation-1",
        causationEventId: "risk-1",
        cycleId: "cycle-1",
        payload: createOrderSubmittedPayloadV1(intent, "cycle-1", "2.0.0", 10_100),
      } as LedgerEventV4),
    ).rejects.toThrow()
    await store.close()
  })

  it("rejects a fill with no recorded submission", async () => {
    const store = await createStore()
    await seedApprovedCycle(store)

    await expect(
      store.append({
        eventId: "fill-1",
        eventVersion: "4.0.0",
        eventType: "ORDER_FILLED",
        occurredAt: TIMESTAMP,
        correlationId: "correlation-1",
        causationEventId: "risk-1",
        cycleId: "cycle-1",
        payload: {
          submissionVersion: "1.0.0",
          clientOrderId: "cycle-1",
          brokerOrderId: "broker-1",
          filledQuantity: 1,
          brokerTimestamp: TIMESTAMP,
        },
      } as LedgerEventV4),
    ).rejects.toThrow()
    await store.close()
  })
})

describe("reconcileOpenOrderRecordsV1", () => {
  const submitOpen = async (store: LedgerStore) => {
    await seedApprovedCycle(store)
    await executeApprovedTradeV1({
      store,
      submitter: stubSubmitter({
        status: "OPEN",
        brokerOrderId: "broker-1",
        brokerStatus: "new",
      }),
      shadowRisk: approvedShadowRisk,
      cycleId: "cycle-1",
      signal: AbortSignal.timeout(5_000),
    })
  }

  it("closes a submission the broker actually filled", async () => {
    const store = await createStore()
    await submitOpen(store)

    const reconciled = await reconcileOpenOrderRecordsV1({
      store,
      submitter: stubSubmitter({
        status: "FILLED",
        brokerOrderId: "broker-1",
        filledQuantity: 1,
        filledAvgPriceCentsPerShare: 100,
        brokerTimestamp: TIMESTAMP,
      }),
      signal: AbortSignal.timeout(5_000),
    })

    expect(reconciled).toEqual([
      { cycleId: "cycle-1", clientOrderId: "cycle-1", resolution: "FILLED" },
    ])
    expect(await eventTypes(store)).toContain("ORDER_FILLED")
    await store.close()
  })

  it("closes a submission the broker never received, without resubmitting", async () => {
    const store = await createStore()
    await submitOpen(store)
    const calls: string[] = []

    const reconciled = await reconcileOpenOrderRecordsV1({
      store,
      submitter: {
        async submit() {
          calls.push("submit")
          throw new Error("reconciliation must never submit")
        },
        async lookup() {
          calls.push("lookup")
          return undefined
        },
      },
      signal: AbortSignal.timeout(5_000),
    })

    expect(reconciled).toEqual([
      { cycleId: "cycle-1", clientOrderId: "cycle-1", resolution: "REJECTED" },
    ])
    expect(calls).toEqual(["lookup"])
    const rejection = (
      await store.list({
        cycleId: "cycle-1",
        eventTypes: ["ORDER_REJECTED"],
        limit: 1,
      })
    )[0]
    expect(rejection?.payload).toMatchObject({ reason: "SUBMISSION_ABANDONED" })
    await store.close()
  })

  it("leaves a still-working order alone", async () => {
    const store = await createStore()
    await submitOpen(store)

    const reconciled = await reconcileOpenOrderRecordsV1({
      store,
      submitter: stubSubmitter({
        status: "OPEN",
        brokerOrderId: "broker-1",
        brokerStatus: "new",
      }),
      signal: AbortSignal.timeout(5_000),
    })

    expect(reconciled).toEqual([
      { cycleId: "cycle-1", clientOrderId: "cycle-1", resolution: "STILL_OPEN" },
    ])
    const types = await eventTypes(store)
    expect(types).not.toContain("ORDER_FILLED")
    expect(types).not.toContain("ORDER_REJECTED")
    await store.close()
  })

  it("does not revisit an already settled submission", async () => {
    const store = await createStore()
    await seedApprovedCycle(store)
    await executeApprovedTradeV1({
      store,
      submitter: stubSubmitter({
        status: "FILLED",
        brokerOrderId: "broker-1",
        filledQuantity: 1,
        brokerTimestamp: TIMESTAMP,
      }),
      shadowRisk: approvedShadowRisk,
      cycleId: "cycle-1",
      signal: AbortSignal.timeout(5_000),
    })
    const calls: string[] = []

    expect(
      await reconcileOpenOrderRecordsV1({
        store,
        submitter: stubSubmitter(
          { status: "OPEN", brokerOrderId: "broker-1", brokerStatus: "new" },
          calls,
        ),
        signal: AbortSignal.timeout(5_000),
      }),
    ).toEqual([])
    expect(calls).toEqual([])
    await store.close()
  })
})

describe("hasHeldExecutedEntryV1", () => {
  it("reports a held entry only after a fill is recorded", async () => {
    const store = await createStore()
    await seedApprovedCycle(store)
    const signal = AbortSignal.timeout(5_000)
    expect(await hasHeldExecutedEntryV1(store, signal)).toBe(false)

    await executeApprovedTradeV1({
      store,
      submitter: stubSubmitter({
        status: "FILLED",
        brokerOrderId: "broker-1",
        filledQuantity: 1,
        brokerTimestamp: TIMESTAMP,
      }),
      shadowRisk: approvedShadowRisk,
      cycleId: "cycle-1",
      signal,
    })

    expect(await hasHeldExecutedEntryV1(store, signal)).toBe(true)
    await store.close()
  })
})
