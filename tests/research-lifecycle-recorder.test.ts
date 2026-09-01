import { describe, expect, it, vi } from "vitest"

import type {
  NoActionDecisionV3,
  ProposedPortfolioDecisionV3,
} from "../src/contracts/research-decision-v3.js"
import { proposalQuoteSnapshotRef } from "../src/contracts/research-decision-v3.js"
import type { ResearchReportV6 } from "../src/contracts/research-report-v6.js"
import type { TradeIntentV3 } from "../src/contracts/trade-intent-v3.js"
import type {
  LedgerEventV4,
  StoredLedgerEventV4,
} from "../src/event-ledger/ledger-event-v1.js"
import type { LedgerStore } from "../src/event-ledger/ledger-store.js"
import { createResearchLifecycleRecorder } from "../src/event-ledger/research-lifecycle-recorder.js"
import { createSqliteLedgerStore } from "../src/event-ledger/sqlite-ledger-store.js"
import type { ResearchCycleTerminalRecordV3 } from "../src/research/cycle/outcome-v3.js"
import type { ResearchInvocationV1 } from "../src/research/invocation-v1.js"

const TIMESTAMP = "2026-08-26T10:00:00.000Z"
const SNAPSHOT_REF = proposalQuoteSnapshotRef("SPY")
const signal = new AbortController().signal

const researchInvocation: ResearchInvocationV1 = {
  invocationVersion: "3.0.0",
  agentName: "research",
  cycleMode: "STANDARD",
  promptVersion: "1.3.0",
  decisionContractVersion: "3.0.0",
  reportVersion: "6.0.0",
  providerId: "test-provider",
  modelId: "test-model",
  responseError: false,
  tokens: {},
  tools: {
    totalCount: 0,
    errorCount: 0,
    incompleteCount: 0,
    omittedCount: 0,
    calls: [],
  },
}

const noActionDecision: NoActionDecisionV3 = {
  contractVersion: "3.0.0",
  outcome: "NO_ACTION",
  reasonCodes: ["SIGNAL_NOT_ACTIONABLE"],
  evidence: [{
    claimId: "mixed-regime",
    kind: "SOURCED_FACT",
    claim: "The retained market regime signal was mixed.",
    provider: "ALPACA",
    temporalClass: "LIVE",
    observedAt: TIMESTAMP,
  }],
}

const researchReport: ResearchReportV6 = {
  reportVersion: "6.0.0",
  result: noActionDecision,
  analysis: {
    provenance: "AGENT_REPORTED",
    asOf: TIMESTAMP,
    accountChecks: {
      verification: "AGENT_REPORTED",
      observedAt: TIMESTAMP,
      accountStatus: "ACTIVE",
      optionsTradingApproved: true,
      conflictingStrategyExposure: false,
    },
    marketRegimes: [{
      verification: "AGENT_REPORTED",
      temporalClass: "LIVE",
      observedAt: TIMESTAMP,
      signal: "MIXED",
      underlying: "SPY",
      dailySessionCount: 50,
      intradayBarCount: 30,
    }],
    symbolEvaluations: [],
    optionSurfaces: [],
    candidateEvaluations: [],
    externalContext: [
      {
        sourceId: "exa-1",
        provider: "EXA",
        verification: "AGENT_REPORTED",
        title: "Current context",
        url: "https://example.com/context",
        publishedAt: "2026-08-26T09:00:00.000Z",
        retrievedAt: TIMESTAMP,
        summary: "Current market context was reviewed.",
        relevance: "NEUTRAL",
      },
    ],
    supportingFactors: [],
    contradictingFactors: [],
    conflicts: [],
  },
}

const proposedDecision: ProposedPortfolioDecisionV3 = {
  contractVersion: "3.0.0",
  outcome: "PROPOSE_TRADES",
  proposals: [{
    priority: 1,
    direction: "BULLISH",
    thesis: "Daily and intraday direction agree.",
    candidate: {
      underlying: "SPY",
      structure: "BULL_CALL_SPREAD",
      expiration: "2026-09-18",
      longLeg: {
        contractSymbol: "SPY260918C00650000",
        strike: 650,
      },
      shortLeg: {
        contractSymbol: "SPY260918C00655000",
        strike: 655,
      },
    },
    invalidation: ["Reject if refreshed evidence changes the candidate."],
    evidence: [{
      claimId: "fact-1",
      kind: "SOURCED_FACT",
      claim: "The exact proposed legs were confirmed.",
      snapshotRef: SNAPSHOT_REF,
    }],
  }],
}

const intent: TradeIntentV3 = {
  contractVersion: "3.0.0",
  decisionContractVersion: "3.0.0",
  underlying: "SPY",
  direction: "BULLISH",
  structure: "BULL_CALL_SPREAD",
  expiration: "2026-09-18",
  longContractSymbol: "SPY260918C00650000",
  shortContractSymbol: "SPY260918C00655000",
  quoteSnapshotRef: SNAPSHOT_REF,
  evaluatedAt: TIMESTAMP,
  longQuote: {
    contractSymbol: "SPY260918C00650000",
    feed: "INDICATIVE",
    bidCentsPerShare: 220,
    askCentsPerShare: 223,
    providerTimestamp: "2026-08-26T09:59:30.000000000Z",
  },
  shortQuote: {
    contractSymbol: "SPY260918C00655000",
    feed: "INDICATIVE",
    bidCentsPerShare: 120,
    askCentsPerShare: 121,
    providerTimestamp: "2026-08-26T09:59:31.000000000Z",
  },
  entryLimitCentsPerShare: 101,
  widthCentsPerShare: 500,
  maxLossCentsPerContract: 10_100,
  maxProfitCentsPerContract: 39_900,
  stopLossMarkHalfCentsPerShare: 101,
  profitTargetMarkHalfCentsPerShare: 601,
}

const shadowRisk = {
  decision: {
    decisionVersion: "1.0.0" as const,
    mode: "SHADOW" as const,
    evaluationVersion: "1.0.0" as const,
    ruleVersion: "1.0.0" as const,
    stage: "STATE_CAPTURE_FAILED" as const,
    outcome: "REJECTED" as const,
    evaluatedAt: null,
    captureReasonCodes: ["CAPTURE_INTERNAL_INVALID" as const],
  },
  breakerTransitions: [],
}

const evidenceSnapshots = [
  {
    snapshotRef: SNAPSHOT_REF,
    provider: "ALPACA",
    source: "options-snapshots-indicative",
    retrievedAt: TIMESTAMP,
    freshUntil: "2026-08-26T10:00:30.000Z",
  },
  {
    snapshotRef: "snapshot-2",
    provider: "FMP",
    source: "market-calendar",
    retrievedAt: TIMESTAMP,
    freshUntil: "2026-08-26T10:01:00.000Z",
  },
] as const

const asStored = (
  event: LedgerEventV4,
  sequence: number,
): StoredLedgerEventV4 =>
  ({
    ...event,
    sequence,
    recordedAt: TIMESTAMP,
  }) as StoredLedgerEventV4

const setup = () => {
  const events: LedgerEventV4[] = []
  const append = vi.fn<LedgerStore["append"]>(async (event, appendSignal) => {
    appendSignal?.throwIfAborted()
    events.push(event)
    return asStored(event, events.length)
  })
  const appendBatch = vi.fn<LedgerStore["appendBatch"]>(
    async (batch, appendSignal) => {
      appendSignal?.throwIfAborted()
      const firstSequence = events.length + 1
      events.push(...batch)
      return batch.map((event, index) =>
        asStored(event, firstSequence + index),
      )
    },
  )
  const list = vi.fn<LedgerStore["list"]>(async () => [])
  const store: LedgerStore = {
    migrate: vi.fn(async () => undefined),
    append,
    appendBatch,
    getByEventId: vi.fn(async () => undefined),
    list,
    close: vi.fn(async () => undefined),
  }
  let nextId = 0
  const recorder = createResearchLifecycleRecorder({
    store,
    idFactory: () => `id-${++nextId}`,
    now: () => new Date(TIMESTAMP),
  })

  return { append, appendBatch, events, list, recorder }
}

const startCycle = async (setupResult: ReturnType<typeof setup>) =>
  setupResult.recorder.startCycle({
    sessionId: "session-1",
    cycleNumber: 7,
    signal,
  })

const assertCausalChain = (
  events: readonly Readonly<{
    eventId: string
    causationEventId?: string | undefined
  }>[],
) => {
  for (let index = 1; index < events.length; index += 1) {
    expect(events[index]!.causationEventId).toBe(events[index - 1]!.eventId)
  }
}

const terminalMappingCases: readonly {
  name: string
  record: ResearchCycleTerminalRecordV3
  eventTypes: readonly LedgerEventV4["eventType"][]
}[] = [
  {
    name: "validated no action",
    record: {
      researchInvocation,
      outcome: {
        outcomeVersion: "3.0.0",
        status: "VALIDATED_NO_ACTION",
        decision: noActionDecision,
      },
      evidenceSnapshots: [],
      validatedDecision: noActionDecision,
      researchReport,
    },
    eventTypes: [
      "RESEARCH_REPORT_RECORDED",
      "RESEARCH_DECISION_VALIDATED",
      "RESEARCH_CYCLE_COMPLETED",
    ],
  },
  {
    name: "decision rejection",
    record: {
      researchInvocation,
      outcome: {
        outcomeVersion: "3.0.0",
        status: "DECISION_REJECTED",
        issues: [{
          code: "SCHEMA_INVALID",
          schemaCategory: "TYPE_MISMATCH",
          path: ["candidate", 0],
        }],
      },
      evidenceSnapshots,
    },
    eventTypes: [
      "EVIDENCE_SNAPSHOT_REFERENCED",
      "EVIDENCE_SNAPSHOT_REFERENCED",
      "RESEARCH_DECISION_REJECTED",
      "RESEARCH_CYCLE_COMPLETED",
    ],
  },
  {
    name: "portfolio intent derivation rejection with a validated decision",
    record: {
      researchInvocation,
      outcome: {
        outcomeVersion: "3.0.0",
        status: "PORTFOLIO_EVALUATED",
        decision: proposedDecision,
        proposals: [{
          priority: 1,
          underlying: "SPY",
          status: "INTENT_DERIVATION_REJECTED",
          reasons: ["QUOTE_STALE"],
        }],
      },
      evidenceSnapshots: [evidenceSnapshots[0]],
      validatedDecision: proposedDecision,
    },
    eventTypes: [
      "EVIDENCE_SNAPSHOT_REFERENCED",
      "RESEARCH_DECISION_VALIDATED",
      "TRADE_INTENT_DERIVATION_REJECTED",
      "PORTFOLIO_SHADOW_PLAN_RECORDED",
      "RESEARCH_CYCLE_COMPLETED",
    ],
  },
  {
    name: "evaluated portfolio without duplicate decision or intent events",
    record: {
      researchInvocation,
      outcome: {
        outcomeVersion: "3.0.0",
        status: "PORTFOLIO_EVALUATED",
        decision: proposedDecision,
        proposals: [{
          priority: 1,
          underlying: "SPY",
          status: "RISK_EVALUATED",
          proposal: proposedDecision.proposals[0]!,
          intent,
          shadowRisk,
          selected: true,
        }],
      },
      evidenceSnapshots: [evidenceSnapshots[0]],
      validatedDecision: proposedDecision,
    },
    eventTypes: [
      "EVIDENCE_SNAPSHOT_REFERENCED",
      "RESEARCH_DECISION_VALIDATED",
      "TRADE_INTENT_DERIVED",
      "RISK_SHADOW_DECISION_RECORDED",
      "PORTFOLIO_SHADOW_PLAN_RECORDED",
      "RESEARCH_CYCLE_COMPLETED",
    ],
  },
]

describe("createResearchLifecycleRecorder", () => {
  it("records an OpenCode session start with generated envelope identity", async () => {
    const state = setup()

    await state.recorder.recordOpenCodeSessionStarted("session-1", signal)

    expect(state.events).toEqual([
      {
        eventId: "id-1",
        eventVersion: "4.0.0",
        eventType: "OPENCODE_SESSION_STARTED",
        occurredAt: TIMESTAMP,
        correlationId: "id-2",
        sessionId: "session-1",
        payload: { sessionId: "session-1" },
      },
    ])
  })

  it("records cycleless research-loop breaker transitions", async () => {
    const state = setup()

    expect(await state.recorder.loadResearchLoopBreakerState()).toEqual({
      latched: false,
    })
    await state.recorder.recordResearchLoopBreakerLatched({
      consecutiveFailures: 5,
      threshold: 5,
      lastAttempt: 9,
    })
    await state.recorder.recordResearchLoopBreakerReset()

    expect(state.events).toEqual([
      {
        eventId: "id-1",
        eventVersion: "4.0.0",
        eventType: "RESEARCH_LOOP_BREAKER_LATCHED",
        occurredAt: TIMESTAMP,
        correlationId: "id-2",
        payload: {
          stateVersion: "1.0.0",
          reason: "CONSECUTIVE_FAILURE_LIMIT",
          consecutiveFailures: 5,
          threshold: 5,
          lastAttempt: 9,
        },
      },
      {
        eventId: "id-3",
        eventVersion: "4.0.0",
        eventType: "RESEARCH_LOOP_BREAKER_RESET",
        occurredAt: TIMESTAMP,
        correlationId: "id-4",
        payload: {
          stateVersion: "1.0.0",
          reason: "OPERATOR_REQUESTED",
        },
      },
    ])
  })

  it("starts a cycle once and returns its stable public identity and sink", async () => {
    const state = setup()

    const cycle = await startCycle(state)

    expect(cycle).toMatchObject({
      cycleId: "id-1",
      correlationId: "id-2",
      sessionId: "session-1",
      cycleNumber: 7,
      startedAt: TIMESTAMP,
      outcomeSink: { record: expect.any(Function) },
      interrupt: expect.any(Function),
    })
    expect(state.events).toEqual([
      {
        eventId: "id-3",
        eventVersion: "4.0.0",
        eventType: "RESEARCH_CYCLE_STARTED",
        occurredAt: TIMESTAMP,
        correlationId: "id-2",
        cycleId: "id-1",
        sessionId: "session-1",
        payload: { cycleNumber: 7 },
      },
    ])
  })

  it("records an invocation-identity rejection against the live cycle", async () => {
    const state = setup()
    const cycle = await startCycle(state)
    state.events.length = 0

    await cycle.recordInvocationIdentityRejected({
      reason: "MODEL_DRIFT",
      expected: "gpt-5.6-sol",
      observed: "gpt-5.6-sol-fast",
    })

    expect(state.events).toEqual([
      {
        eventId: "id-4",
        eventVersion: "4.0.0",
        eventType: "RESEARCH_INVOCATION_IDENTITY_REJECTED",
        occurredAt: TIMESTAMP,
        correlationId: "id-2",
        causationEventId: "id-3",
        cycleId: "id-1",
        sessionId: "session-1",
        payload: {
          invocationVersion: "6.0.0",
          reason: "MODEL_DRIFT",
          expected: "gpt-5.6-sol",
          observed: "gpt-5.6-sol-fast",
        },
      },
    ])
  })

  it("leaves the cycle terminalizable after an identity rejection", async () => {
    // The rejection is evidence, not a terminal state: the caller throws and
    // the resulting interruption is what closes the cycle.
    const state = setup()
    const cycle = await startCycle(state)

    await cycle.recordInvocationIdentityRejected({
      reason: "PROVIDER_DRIFT",
      expected: "openai",
      observed: "anthropic",
    })
    await cycle.interrupt("FAILED")

    expect(state.events.map(({ eventType }) => eventType)).toEqual([
      "RESEARCH_CYCLE_STARTED",
      "RESEARCH_INVOCATION_IDENTITY_REJECTED",
      "RESEARCH_CYCLE_INTERRUPTED",
    ])
  })

  it("records the session date and initial eligibility with a new cycle", async () => {
    const state = setup()
    await state.recorder.startCycle({
      sessionId: "session-1",
      cycleNumber: 7,
      sessionDate: "2026-08-26",
      initialEligibility: {
        evaluatedAt: TIMESTAMP,
        sessionDate: "2026-08-26",
        researchEligible: true,
        tradeIntentEligible: false,
        previousSessionDates: ["2026-08-25"],
        researchMode: "DRY_RUN",
        reason: "DRY_RUN_RESEARCH_ONLY",
      },
      signal,
    })

    expect(state.events[0]).toMatchObject({
      eventType: "RESEARCH_CYCLE_STARTED",
      payload: {
        cycleNumber: 7,
        sessionDate: "2026-08-26",
        initialEligibility: {
          evaluatedAt: TIMESTAMP,
          researchEligible: true,
          previousSessionDates: ["2026-08-25"],
          researchMode: "DRY_RUN",
          reason: "DRY_RUN_RESEARCH_ONLY",
        },
      },
    })
  })

  it.each(terminalMappingCases)(
    "maps $name to one atomic causal batch",
    async ({ record, eventTypes }) => {
      const state = setup()
      const cycle = await startCycle(state)

      await cycle.outcomeSink.record(record, signal)

      expect(state.appendBatch).toHaveBeenCalledOnce()
      const terminalEvents = state.events.slice(1)
      expect(terminalEvents.map(({ eventType }) => eventType)).toEqual(eventTypes)
      expect(terminalEvents.at(-1)).toMatchObject({
        eventType: "RESEARCH_CYCLE_COMPLETED",
        payload: {
          status: record.outcome.status,
          researchInvocation,
        },
      })
      expect(
        terminalEvents.every(
          (event) =>
            event.cycleId === cycle.cycleId &&
            event.correlationId === cycle.correlationId &&
            event.sessionId === cycle.sessionId &&
            event.occurredAt === TIMESTAMP,
        ),
      ).toBe(true)
      assertCausalChain(state.events)
    },
  )

  it("rejects missing invocation metadata at the runtime boundary", async () => {
    const state = setup()
    const cycle = await startCycle(state)
    const missingInvocation = {
      outcome: {
        outcomeVersion: "3.0.0",
        status: "VALIDATED_NO_ACTION",
        decision: noActionDecision,
      },
      evidenceSnapshots: [],
      validatedDecision: noActionDecision,
    } as unknown as ResearchCycleTerminalRecordV3

    await expect(
      cycle.outcomeSink.record(missingInvocation, signal),
    ).rejects.toMatchObject({
      message: "Ledger cycle-completion append failed",
      cause: expect.objectContaining({
        message: "Completed research cycles require invocation metadata",
      }),
    })
    expect(state.appendBatch).not.toHaveBeenCalled()
  })

  it("preserves evidence order and normalized rejection details", async () => {
    const state = setup()
    const cycle = await startCycle(state)

    await cycle.outcomeSink.record(
      {
        outcome: {
          outcomeVersion: "3.0.0",
          status: "DECISION_REJECTED",
          issues: [{
            code: "SCHEMA_INVALID",
            schemaCategory: "TYPE_MISMATCH",
            path: ["candidate", 0],
          }],
        },
        evidenceSnapshots,
        researchInvocation,
      },
      signal,
    )

    expect(state.events.slice(1).map(({ payload }) => payload)).toEqual([
      evidenceSnapshots[0],
      evidenceSnapshots[1],
      {
        issues: [{
          code: "SCHEMA_INVALID",
          schemaCategory: "TYPE_MISMATCH",
          path: ["candidate", 0],
        }],
      },
      { status: "DECISION_REJECTED", researchInvocation },
    ])
  })

  it.each([
    "TIMEOUT",
    "CANCELLED",
    "SHUTDOWN",
    "PROCESS_RESTART",
    "FAILED",
  ] as const)("interrupts an active cycle with %s", async (reason) => {
    const state = setup()
    const cycle = await startCycle(state)

    await cycle.interrupt(reason, signal)

    expect(state.events.at(-1)).toEqual({
      eventId: "id-4",
      eventVersion: "4.0.0",
      eventType: "RESEARCH_CYCLE_INTERRUPTED",
      occurredAt: TIMESTAMP,
      correlationId: cycle.correlationId,
      causationEventId: "id-3",
      cycleId: cycle.cycleId,
      sessionId: cycle.sessionId,
      payload: { reason },
    })
  })

  it("keeps a failed atomic completion retryable without partial events", async () => {
    const state = setup()
    const cycle = await startCycle(state)
    const terminalRecord: ResearchCycleTerminalRecordV3 = {
      outcome: {
        outcomeVersion: "3.0.0",
        status: "VALIDATED_NO_ACTION",
        decision: noActionDecision,
      },
      evidenceSnapshots: [],
      researchInvocation,
      validatedDecision: noActionDecision,
    }
    state.appendBatch.mockRejectedValueOnce(new Error("atomic write failed"))

    await expect(
      cycle.outcomeSink.record(terminalRecord, signal),
    ).rejects.toThrow("Ledger cycle-completion append failed")
    expect(state.events.map(({ eventType }) => eventType)).toEqual([
      "RESEARCH_CYCLE_STARTED",
    ])

    await cycle.outcomeSink.record(terminalRecord, signal)
    expect(state.events.map(({ eventType }) => eventType)).toEqual([
      "RESEARCH_CYCLE_STARTED",
      "RESEARCH_DECISION_VALIDATED",
      "RESEARCH_CYCLE_COMPLETED",
    ])
  })

  it("allows exactly one winner in a completion-interruption race", async () => {
    const state = setup()
    const cycle = await startCycle(state)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    state.appendBatch.mockImplementationOnce(async (batch) => {
      await blocked
      const firstSequence = state.events.length + 1
      state.events.push(...batch)
      return batch.map((event, index) =>
        asStored(event, firstSequence + index),
      )
    })

    const completion = cycle.outcomeSink.record(
      {
        outcome: {
          outcomeVersion: "3.0.0",
          status: "VALIDATED_NO_ACTION",
          decision: noActionDecision,
        },
        evidenceSnapshots: [],
        researchInvocation,
        validatedDecision: noActionDecision,
      },
      signal,
    )
    const interruption = cycle.interrupt("TIMEOUT", signal)

    expect(state.append).toHaveBeenCalledOnce()
    release()
    await Promise.all([completion, interruption])
    expect(state.events.map(({ eventType }) => eventType)).toEqual([
      "RESEARCH_CYCLE_STARTED",
      "RESEARCH_DECISION_VALIDATED",
      "RESEARCH_CYCLE_COMPLETED",
    ])
  })

  it("keeps an interruption terminal when completion arrives afterward", async () => {
    const state = setup()
    const cycle = await startCycle(state)

    await cycle.interrupt("PROCESS_RESTART", signal)
    await cycle.outcomeSink.record(
      {
        outcome: {
          outcomeVersion: "3.0.0",
          status: "VALIDATED_NO_ACTION",
          decision: noActionDecision,
        },
        evidenceSnapshots: [],
        researchInvocation,
        validatedDecision: noActionDecision,
      },
      signal,
    )

    expect(state.appendBatch).not.toHaveBeenCalled()
    expect(state.events.map(({ eventType }) => eventType)).toEqual([
      "RESEARCH_CYCLE_STARTED",
      "RESEARCH_CYCLE_INTERRUPTED",
    ])
  })

  it("lets a waiting interruption terminate after a racing completion fails", async () => {
    const state = setup()
    const cycle = await startCycle(state)
    let rejectWrite!: (error: Error) => void
    state.appendBatch.mockImplementationOnce(
      async () =>
        new Promise<readonly StoredLedgerEventV4[]>((_resolve, reject) => {
          rejectWrite = reject
        }),
    )

    const completion = cycle.outcomeSink.record(
      {
        outcome: {
          outcomeVersion: "3.0.0",
          status: "VALIDATED_NO_ACTION",
          decision: noActionDecision,
        },
        evidenceSnapshots: [],
        researchInvocation,
        validatedDecision: noActionDecision,
      },
      signal,
    )
    const interruption = cycle.interrupt("SHUTDOWN", signal)
    rejectWrite(new Error("completion failed"))

    await expect(completion).rejects.toThrow(
      "Ledger cycle-completion append failed",
    )
    await interruption
    expect(state.events.map(({ eventType }) => eventType)).toEqual([
      "RESEARCH_CYCLE_STARTED",
      "RESEARCH_CYCLE_INTERRUPTED",
    ])
  })

  it("does not start or terminalize with an already-aborted signal", async () => {
    const state = setup()
    const aborted = AbortSignal.abort(new Error("cancelled"))

    await expect(
      state.recorder.startCycle({
        sessionId: "session-1",
        cycleNumber: 1,
        signal: aborted,
      }),
    ).rejects.toThrow("cancelled")
    expect(state.events).toEqual([])

    const cycle = await startCycle(state)
    await expect(cycle.interrupt("CANCELLED", aborted)).rejects.toThrow(
      "cancelled",
    )
    expect(state.events.map(({ eventType }) => eventType)).toEqual([
      "RESEARCH_CYCLE_STARTED",
    ])
  })

  it("reconstructs durable research-loop breaker state through SQLite", async () => {
    const store = createSqliteLedgerStore({
      path: ":memory:",
      knownCredentialValues: [],
      now: () => new Date(TIMESTAMP),
    })
    await store.migrate()
    let nextId = 0
    const createRecorder = () =>
      createResearchLifecycleRecorder({
        store,
        idFactory: () => `breaker-id-${++nextId}`,
        now: () => new Date(TIMESTAMP),
      })

    expect(await createRecorder().loadResearchLoopBreakerState()).toEqual({
      latched: false,
    })
    await createRecorder().recordResearchLoopBreakerLatched({
      consecutiveFailures: 5,
      threshold: 5,
      lastAttempt: 9,
    })
    expect(await createRecorder().loadResearchLoopBreakerState()).toEqual({
      latched: true,
      consecutiveFailures: 5,
      threshold: 5,
      lastAttempt: 9,
    })
    await createRecorder().recordResearchLoopBreakerReset()
    expect(await createRecorder().loadResearchLoopBreakerState()).toEqual({
      latched: false,
    })
    expect(
      (
        await store.list({
          eventTypes: [
            "RESEARCH_LOOP_BREAKER_LATCHED",
            "RESEARCH_LOOP_BREAKER_RESET",
          ],
          limit: 10,
        })
      ).map(({ eventType }) => eventType),
    ).toEqual([
      "RESEARCH_LOOP_BREAKER_LATCHED",
      "RESEARCH_LOOP_BREAKER_RESET",
    ])
    await store.close()
  })

  it("persists a complete chain through the SQLite store and migration constraints", async () => {
    const store = createSqliteLedgerStore({
      path: ":memory:",
      knownCredentialValues: [],
      now: () => new Date(TIMESTAMP),
    })
    await store.migrate()
    let nextId = 0
    const recorder = createResearchLifecycleRecorder({
      store,
      idFactory: () => `sqlite-id-${++nextId}`,
      now: () => new Date(TIMESTAMP),
    })
    await recorder.recordOpenCodeSessionStarted("session-1", signal)
    const cycle = await recorder.startCycle({
      sessionId: "session-1",
      cycleNumber: 1,
      signal,
    })

    await cycle.outcomeSink.record(
      {
        outcome: {
          outcomeVersion: "3.0.0",
          status: "PORTFOLIO_EVALUATED",
          decision: proposedDecision,
          proposals: [{
            priority: 1,
            underlying: "SPY",
            status: "RISK_EVALUATED",
            proposal: proposedDecision.proposals[0]!,
            intent,
            shadowRisk: {
              ...shadowRisk,
              breakerTransitions: [
                {
                  stateVersion: "1.0.0",
                  tradingDate: "2026-08-26",
                  observedAt: TIMESTAMP,
                  breaker: "DAILY",
                },
              ],
            },
            selected: true,
          }],
        },
        evidenceSnapshots: [evidenceSnapshots[0]],
        researchInvocation,
        validatedDecision: proposedDecision,
      },
      signal,
    )

    const stored = await store.list({ cycleId: cycle.cycleId, limit: 10 })
    expect(stored.map(({ eventType }) => eventType)).toEqual([
      "RESEARCH_CYCLE_STARTED",
      "EVIDENCE_SNAPSHOT_REFERENCED",
      "RESEARCH_DECISION_VALIDATED",
      "TRADE_INTENT_DERIVED",
      "RISK_SHADOW_DECISION_RECORDED",
      "RISK_BREAKER_LATCHED",
      "PORTFOLIO_SHADOW_PLAN_RECORDED",
      "RESEARCH_CYCLE_COMPLETED",
    ])
    assertCausalChain(stored)
    await store.close()
  })
})
