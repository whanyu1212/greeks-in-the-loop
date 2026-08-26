import { describe, expect, it, vi } from "vitest"

import type { TradeIntentDerivationResult } from "../src/contracts/trade-intent-v1.js"
import type { ProposedTradeDecisionV1 } from "../src/contracts/research-decision-v1.js"
import type { OptionQuoteProvider } from "../src/market-data/alpaca-option-quotes.js"
import { MAX_LEDGER_EVENT_PAYLOAD_BYTES } from "../src/event-ledger/ledger-event-v1.js"
import {
  MAX_RESEARCH_RESPONSE_BYTES,
  processResearchCycle,
  PROPOSAL_QUOTE_SNAPSHOT_REF,
} from "../src/research/research-cycle.js"
import { createConsoleResearchCycleOutcomeSink } from "../src/research/research-cycle-outcome-v1.js"
import type {
  ResearchCycleOutcomeSink,
  ResearchCycleOutcomeV1,
  ResearchCycleTerminalRecordV1,
} from "../src/research/research-cycle-outcome-v1.js"

const noAction = {
  contractVersion: "1.0.0",
  strategyVersion: "1.0.0",
  outcome: "NO_ACTION",
  reasonCodes: ["SIGNAL_NOT_ACTIONABLE"],
} as const

const proposal = {
  contractVersion: "1.0.0",
  strategyVersion: "1.0.0",
  outcome: "PROPOSE_TRADE",
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
  evidence: [
    {
      claimId: "fact-1",
      kind: "SOURCED_FACT",
      claim: "The exact proposed legs were confirmed.",
      snapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
    },
  ],
} as const

const quoteSnapshot = {
  evaluatedAt: "2026-08-25T14:31:00.000Z",
  snapshotMetadata: {
    provider: "ALPACA",
    source: "options-snapshots-indicative",
    retrievedAt: "2026-08-25T14:31:00.000Z",
    freshUntil: "2026-08-25T14:31:30.000Z",
  },
  longQuote: {
    contractSymbol: proposal.candidate.longLeg.contractSymbol,
    feed: "INDICATIVE",
    bidCentsPerShare: 220,
    askCentsPerShare: 223,
    providerTimestamp: "2026-08-25T14:30:30.000000000Z",
  },
  shortQuote: {
    contractSymbol: proposal.candidate.shortLeg.contractSymbol,
    feed: "INDICATIVE",
    bidCentsPerShare: 120,
    askCentsPerShare: 121,
    providerTimestamp: "2026-08-25T14:30:31.000000000Z",
  },
} as const

const setup = () => {
  const outcomes: ResearchCycleOutcomeV1[] = []
  const records: ResearchCycleTerminalRecordV1[] = []
  const record = vi.fn<ResearchCycleOutcomeSink["record"]>(
    async (terminalRecord, signal) => {
      signal.throwIfAborted()
      records.push(terminalRecord)
      outcomes.push(terminalRecord.outcome)
    },
  )
  const outcomeSink: ResearchCycleOutcomeSink = { record }
  const confirmQuotes = vi.fn<OptionQuoteProvider["confirmQuotes"]>(
    async () => ({
      success: true,
      snapshot: quoteSnapshot,
    }),
  )
  const quoteProvider: OptionQuoteProvider = { confirmQuotes }
  const deriveIntent = vi.fn<
    (
      decision: ProposedTradeDecisionV1,
      context: Parameters<
        NonNullable<
          Parameters<typeof processResearchCycle>[0]["deriveIntent"]
        >
      >[1],
    ) => TradeIntentDerivationResult
  >(() => ({
    success: true,
    intent: {
      contractVersion: "1.0.0",
      decisionContractVersion: "1.0.0",
      strategyVersion: "1.0.0",
      direction: "BULLISH",
      structure: "BULL_CALL_SPREAD",
      expiration: "2026-09-18",
      longContractSymbol: proposal.candidate.longLeg.contractSymbol,
      shortContractSymbol: proposal.candidate.shortLeg.contractSymbol,
      quoteSnapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
      evaluatedAt: quoteSnapshot.evaluatedAt,
      longQuote: quoteSnapshot.longQuote,
      shortQuote: quoteSnapshot.shortQuote,
      entryLimitCentsPerShare: 101,
      widthCentsPerShare: 500,
      maxLossCentsPerContract: 10_100,
      maxProfitCentsPerContract: 39_900,
      stopLossMarkHalfCentsPerShare: 101,
      profitTargetMarkHalfCentsPerShare: 601,
    },
  }))

  return {
    outcomes,
    records,
    outcomeSink,
    record,
    quoteProvider,
    confirmQuotes,
    deriveIntent,
  }
}

describe("processResearchCycle", () => {
  it("records a valid minimal NO_ACTION without quotes or derivation", async () => {
    const dependencies = setup()

    const result = await processResearchCycle({
      rawResponse: JSON.stringify(noAction),
      signal: new AbortController().signal,
      now: () => new Date("2026-08-25T14:31:00.000Z"),
      ...dependencies,
    })

    expect(result.outcome).toEqual({
      outcomeVersion: "1.0.0",
      status: "VALIDATED_NO_ACTION",
      decision: {
        ...noAction,
        evidence: [],
      },
    })
    expect(dependencies.quoteProvider.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
    expect(dependencies.outcomes).toEqual([result.outcome])
    expect(dependencies.records).toEqual([
      {
        outcome: result.outcome,
        evidenceSnapshots: [],
        validatedDecision: { ...noAction, evidence: [] },
      },
    ])
  })

  it.each([
    "not-json",
    "```json\n{}\n```",
    `report\n${JSON.stringify(noAction)}`,
  ])("rejects malformed or mixed response without raw payload: %s", async (rawResponse) => {
    const dependencies = setup()
    const secretMarker = "must-not-be-recorded"

    const result = await processResearchCycle({
      rawResponse: `${rawResponse}${secretMarker}`,
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toEqual({
      outcomeVersion: "1.0.0",
      status: "DECISION_REJECTED",
      issues: [{ code: "MALFORMED_JSON", path: [] }],
    })
    expect(JSON.stringify(result)).not.toContain(secretMarker)
    expect(dependencies.quoteProvider.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
    expect(dependencies.records).toEqual([
      { outcome: result.outcome, evidenceSnapshots: [] },
    ])
  })

  it("rejects oversized UTF-8 output before parsing or quote confirmation", async () => {
    const dependencies = setup()
    const secretMarker = "must-not-be-recorded"
    const rawResponse =
      "é".repeat(MAX_RESEARCH_RESPONSE_BYTES / 2) + secretMarker

    const result = await processResearchCycle({
      rawResponse,
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toEqual({
      outcomeVersion: "1.0.0",
      status: "DECISION_REJECTED",
      issues: [{ code: "RESPONSE_TOO_LARGE", path: [] }],
    })
    expect(Buffer.byteLength(rawResponse, "utf8")).toBeGreaterThan(
      MAX_RESEARCH_RESPONSE_BYTES,
    )
    expect(rawResponse.length).toBeLessThan(MAX_RESEARCH_RESPONSE_BYTES)
    expect(JSON.stringify(result)).not.toContain(secretMarker)
    expect(dependencies.quoteProvider.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("rejects a normalized decision that would exceed the ledger payload bound", async () => {
    const dependencies = setup()
    const largeProposal = {
      ...proposal,
      thesis: "x",
      invalidation: Array.from({ length: 16 }, () => "x"),
      evidence: Array.from({ length: 30 }, (_, index) => ({
        ...proposal.evidence[0],
        claimId: `fact-${index}`,
        claim: "x",
      })),
    }
    const textFields = [
      () => largeProposal.thesis,
      ...largeProposal.invalidation.map((_, index) => () =>
        largeProposal.invalidation[index]!,
      ),
      ...largeProposal.evidence.map((_, index) => () =>
        largeProposal.evidence[index]!.claim,
      ),
    ]
    const setTextFields = [
      (value: string) => {
        largeProposal.thesis = value
      },
      ...largeProposal.invalidation.map((_, index) => (value: string) => {
        largeProposal.invalidation[index] = value
      }),
      ...largeProposal.evidence.map((_, index) => (value: string) => {
        largeProposal.evidence[index]!.claim = value
      }),
    ]
    const targetBytes = MAX_LEDGER_EVENT_PAYLOAD_BYTES - 6
    let remaining = targetBytes - Buffer.byteLength(JSON.stringify(largeProposal), "utf8")
    for (const [index, readText] of textFields.entries()) {
      if (remaining <= 0) break
      const current = readText()
      const added = Math.min(2_000 - current.length, remaining)
      setTextFields[index]!(current + "x".repeat(added))
      remaining -= added
    }
    const rawResponse = JSON.stringify(largeProposal)

    expect(remaining).toBe(0)
    expect(Buffer.byteLength(rawResponse, "utf8")).toBe(targetBytes)
    expect(
      Buffer.byteLength(
        JSON.stringify({ decision: JSON.parse(rawResponse) }),
        "utf8",
      ),
    ).toBeGreaterThan(MAX_LEDGER_EVENT_PAYLOAD_BYTES)

    const result = await processResearchCycle({
      rawResponse,
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toEqual({
      outcomeVersion: "1.0.0",
      status: "DECISION_REJECTED",
      issues: [{ code: "RESPONSE_TOO_LARGE", path: [] }],
    })
    expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.record).toHaveBeenCalledWith(
      {
        outcome: result.outcome,
        evidenceSnapshots: [],
      },
      expect.any(AbortSignal),
    )
  })

  it("rejects schema-invalid output before quote confirmation", async () => {
    const dependencies = setup()

    const result = await processResearchCycle({
      rawResponse: JSON.stringify({
        ...proposal,
        entryLimit: 1.01,
      }),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome.status).toBe("DECISION_REJECTED")
    expect(dependencies.quoteProvider.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
    expect(dependencies.records).toEqual([
      { outcome: result.outcome, evidenceSnapshots: [] },
    ])
  })

  it("caps recorded schema issues at the ledger schema maximum", async () => {
    const dependencies = setup()

    const result = await processResearchCycle({
      rawResponse: JSON.stringify({
        ...noAction,
        evidence: Array.from({ length: 64 }, () => ({})),
      }),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({ status: "DECISION_REJECTED" })
    if (result.outcome.status !== "DECISION_REJECTED") {
      throw new Error("Expected decision rejection")
    }
    expect(result.outcome.issues).toHaveLength(64)
    expect(dependencies.records).toEqual([
      { outcome: result.outcome, evidenceSnapshots: [] },
    ])
  })

  it("rejects NO_ACTION evidence that has no trusted snapshot", async () => {
    const dependencies = setup()

    const result = await processResearchCycle({
      rawResponse: JSON.stringify({
        ...noAction,
        evidence: [proposal.evidence[0]],
      }),
      signal: new AbortController().signal,
      now: () => new Date("2026-08-25T14:31:00.000Z"),
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "DECISION_REJECTED",
      issues: [{ code: "UNKNOWN_SNAPSHOT" }],
    })
    expect(dependencies.quoteProvider.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("rejects invalid evidence topology before a failing provider can mask it", async () => {
    const dependencies = setup()
    dependencies.confirmQuotes.mockResolvedValue({
      success: false,
      reasons: ["QUOTE_REQUEST_FAILED"],
    })

    const result = await processResearchCycle({
      rawResponse: JSON.stringify({
        ...proposal,
        evidence: [proposal.evidence[0], { ...proposal.evidence[0] }],
      }),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "DECISION_REJECTED",
      issues: [{ code: "DUPLICATE_CLAIM_ID" }],
    })
    expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("fetches only the exact proposed symbols", async () => {
    const dependencies = setup()

    await processResearchCycle({
      rawResponse: JSON.stringify(proposal),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(dependencies.quoteProvider.confirmQuotes).toHaveBeenCalledWith({
      longContractSymbol: proposal.candidate.longLeg.contractSymbol,
      shortContractSymbol: proposal.candidate.shortLeg.contractSymbol,
      signal: expect.any(AbortSignal),
    })
  })

  it("rejects an already-aborted cycle before parsing or recording", async () => {
    const dependencies = setup()
    const abortReason = new DOMException("Timed out", "TimeoutError")

    await expect(
      processResearchCycle({
        rawResponse: JSON.stringify(noAction),
        signal: AbortSignal.abort(abortReason),
        ...dependencies,
      }),
    ).rejects.toBe(abortReason)
    expect(dependencies.record).not.toHaveBeenCalled()
    expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("does not record when cancellation happens immediately before the sink", async () => {
    const dependencies = setup()
    const controller = new AbortController()
    const abortReason = new DOMException("Timed out", "TimeoutError")
    dependencies.record.mockImplementation(async (_outcome, signal) => {
      controller.abort(abortReason)
      signal.throwIfAborted()
    })

    await expect(
      processResearchCycle({
        rawResponse: JSON.stringify(noAction),
        signal: controller.signal,
        ...dependencies,
      }),
    ).rejects.toBe(abortReason)
    expect(dependencies.outcomes).toEqual([])
  })

  it("propagates quote cancellation without recording an outcome", async () => {
    const dependencies = setup()
    const abortReason = new DOMException("Timed out", "TimeoutError")
    dependencies.confirmQuotes.mockRejectedValue(abortReason)

    await expect(
      processResearchCycle({
        rawResponse: JSON.stringify(proposal),
        signal: AbortSignal.abort(abortReason),
        ...dependencies,
      }),
    ).rejects.toBe(abortReason)
    expect(dependencies.record).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("records quote failures as derivation rejection without a decision", async () => {
    const dependencies = setup()
    dependencies.confirmQuotes.mockResolvedValue({
      success: false,
      reasons: ["QUOTE_STALE"],
    })

    const result = await processResearchCycle({
      rawResponse: JSON.stringify(proposal),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toEqual({
      outcomeVersion: "1.0.0",
      status: "INTENT_DERIVATION_REJECTED",
      reasons: ["QUOTE_STALE"],
    })
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
    expect(dependencies.records).toEqual([
      { outcome: result.outcome, evidenceSnapshots: [] },
    ])
  })

  it("rejects an unknown proposal snapshot before derivation", async () => {
    const dependencies = setup()

    const result = await processResearchCycle({
      rawResponse: JSON.stringify({
        ...proposal,
        evidence: [
          {
            ...proposal.evidence[0],
            snapshotRef: "agent-invented-snapshot",
          },
        ],
      }),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "DECISION_REJECTED",
      issues: [{ code: "UNKNOWN_SNAPSHOT" }],
    })
    expect(dependencies.quoteProvider.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("records a validated proposal and deterministic intent", async () => {
    const dependencies = setup()

    const result = await processResearchCycle({
      rawResponse: JSON.stringify(proposal),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      outcomeVersion: "1.0.0",
      status: "INTENT_DERIVED",
      decision: proposal,
      intent: {
        quoteSnapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
      },
    })
    expect(dependencies.deriveIntent).toHaveBeenCalledOnce()
    expect(dependencies.outcomes).toEqual([result.outcome])
    expect(dependencies.records).toEqual([
      {
        outcome: result.outcome,
        evidenceSnapshots: [
          {
            snapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
            ...quoteSnapshot.snapshotMetadata,
          },
        ],
        validatedDecision: proposal,
      },
    ])
  })

  it("integrates the real deterministic deriver", async () => {
    const dependencies = setup()

    const result = await processResearchCycle({
      rawResponse: JSON.stringify(proposal),
      signal: new AbortController().signal,
      quoteProvider: dependencies.quoteProvider,
      outcomeSink: dependencies.outcomeSink,
    })

    expect(result.outcome).toMatchObject({
      status: "INTENT_DERIVED",
      intent: {
        entryLimitCentsPerShare: 101,
        widthCentsPerShare: 500,
        maxLossCentsPerContract: 10_100,
        maxProfitCentsPerContract: 39_900,
      },
    })
  })

  it("blocks stale trusted metadata before derivation", async () => {
    const dependencies = setup()
    dependencies.confirmQuotes.mockResolvedValue({
      success: true,
      snapshot: {
        ...quoteSnapshot,
        snapshotMetadata: {
          ...quoteSnapshot.snapshotMetadata,
          retrievedAt: "2026-08-25T14:30:30.000Z",
          freshUntil: "2026-08-25T14:30:59.999Z",
        },
      },
    })

    const result = await processResearchCycle({
      rawResponse: JSON.stringify(proposal),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "DECISION_REJECTED",
      issues: [{ code: "STALE_SNAPSHOT" }],
    })
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
    expect(dependencies.records).toEqual([
      {
        outcome: result.outcome,
        evidenceSnapshots: [
          {
            snapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
            ...quoteSnapshot.snapshotMetadata,
            retrievedAt: "2026-08-25T14:30:30.000Z",
            freshUntil: "2026-08-25T14:30:59.999Z",
          },
        ],
      },
    ])
  })

  it("records bounded pure-derivation rejection reasons", async () => {
    const dependencies = setup()
    dependencies.deriveIntent.mockReturnValue({
      success: false,
      reasons: ["NON_POSITIVE_NET_DEBIT"],
    })

    const result = await processResearchCycle({
      rawResponse: JSON.stringify(proposal),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toEqual({
      outcomeVersion: "1.0.0",
      status: "INTENT_DERIVATION_REJECTED",
      reasons: ["NON_POSITIVE_NET_DEBIT"],
    })
    expect(dependencies.records).toEqual([
      {
        outcome: result.outcome,
        evidenceSnapshots: [
          {
            snapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
            ...quoteSnapshot.snapshotMetadata,
          },
        ],
        validatedDecision: proposal,
      },
    ])
  })

  it("caps recorded derivation reasons at the ledger schema maximum", async () => {
    const dependencies = setup()
    dependencies.deriveIntent.mockReturnValue({
      success: false,
      reasons: Array.from(
        { length: 65 },
        () => "NON_POSITIVE_NET_DEBIT" as const,
      ),
    })

    const result = await processResearchCycle({
      rawResponse: JSON.stringify(proposal),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "INTENT_DERIVATION_REJECTED",
    })
    if (result.outcome.status !== "INTENT_DERIVATION_REJECTED") {
      throw new Error("Expected intent derivation rejection")
    }
    expect(result.outcome.reasons).toHaveLength(64)
    expect(dependencies.records).toEqual([
      {
        outcome: result.outcome,
        evidenceSnapshots: [
          {
            snapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
            ...quoteSnapshot.snapshotMetadata,
          },
        ],
        validatedDecision: proposal,
      },
    ])
  })

  it("prints only the outcome from a terminal record", async () => {
    const write = vi.fn<(line: string) => void>()
    const sink = createConsoleResearchCycleOutcomeSink(write)
    const decision: Extract<
      ResearchCycleOutcomeV1,
      { status: "VALIDATED_NO_ACTION" }
    >["decision"] = {
      ...noAction,
      reasonCodes: [...noAction.reasonCodes],
      evidence: [],
    }
    const outcome = {
      outcomeVersion: "1.0.0",
      status: "VALIDATED_NO_ACTION",
      decision,
    } satisfies ResearchCycleOutcomeV1

    await sink.record(
      {
        outcome,
        evidenceSnapshots: [],
        validatedDecision: decision,
      },
      new AbortController().signal,
    )

    expect(write).toHaveBeenCalledWith(JSON.stringify(outcome))
  })

  it("awaits the outcome sink before completing", async () => {
    const dependencies = setup()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    dependencies.record.mockImplementation(async () => blocked)

    let completed = false
    const processing = processResearchCycle({
      rawResponse: JSON.stringify(noAction),
      signal: new AbortController().signal,
      ...dependencies,
    }).then(() => {
      completed = true
    })

    await Promise.resolve()
    expect(completed).toBe(false)
    release()
    await processing
    expect(completed).toBe(true)
  })

  it("propagates sink failures to the scheduler", async () => {
    const dependencies = setup()
    dependencies.record.mockImplementation(async () => {
      throw new Error("sink unavailable")
    })

    await expect(
      processResearchCycle({
        rawResponse: JSON.stringify(noAction),
        signal: new AbortController().signal,
        ...dependencies,
      }),
    ).rejects.toThrow("sink unavailable")
  })

  it("keeps the reserved quote alias invocation-local across overlapping cycles", async () => {
    const secondProposal = {
      ...proposal,
      candidate: {
        ...proposal.candidate,
        longLeg: {
          contractSymbol: "SPY260918C00660000",
          strike: 660,
        },
        shortLeg: {
          contractSymbol: "SPY260918C00665000",
          strike: 665,
        },
      },
    } as const
    const first = setup()
    const second = setup()
    const secondSnapshot = {
      ...quoteSnapshot,
      evaluatedAt: "2026-08-25T14:32:00.000Z",
      snapshotMetadata: {
        ...quoteSnapshot.snapshotMetadata,
        retrievedAt: "2026-08-25T14:32:00.000Z",
        freshUntil: "2026-08-25T14:32:30.000Z",
      },
      longQuote: {
        ...quoteSnapshot.longQuote,
        contractSymbol: secondProposal.candidate.longLeg.contractSymbol,
        providerTimestamp: "2026-08-25T14:31:30.000000000Z",
      },
      shortQuote: {
        ...quoteSnapshot.shortQuote,
        contractSymbol: secondProposal.candidate.shortLeg.contractSymbol,
        providerTimestamp: "2026-08-25T14:31:31.000000000Z",
      },
    } as const
    second.confirmQuotes.mockResolvedValue({
      success: true,
      snapshot: secondSnapshot,
    })

    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    first.confirmQuotes.mockImplementation(async () => {
      await firstBlocked
      return { success: true, snapshot: quoteSnapshot }
    })

    const firstProcessing = processResearchCycle({
      rawResponse: JSON.stringify(proposal),
      signal: new AbortController().signal,
      ...first,
    })
    const secondResult = await processResearchCycle({
      rawResponse: JSON.stringify(secondProposal),
      signal: new AbortController().signal,
      ...second,
    })
    releaseFirst()
    const firstResult = await firstProcessing

    expect(second.deriveIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: secondProposal.candidate,
      }),
      expect.objectContaining({
        quoteSnapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
        longQuote: secondSnapshot.longQuote,
        shortQuote: secondSnapshot.shortQuote,
      }),
    )
    expect(first.deriveIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: proposal.candidate,
      }),
      expect.objectContaining({
        quoteSnapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
        longQuote: quoteSnapshot.longQuote,
        shortQuote: quoteSnapshot.shortQuote,
      }),
    )
    expect(firstResult.outcome.status).toBe("INTENT_DERIVED")
    expect(secondResult.outcome.status).toBe("INTENT_DERIVED")
  })

  it("produces identical outcomes for fixed inputs", async () => {
    const first = setup()
    const second = setup()

    const firstResult = await processResearchCycle({
      rawResponse: JSON.stringify(proposal),
      signal: new AbortController().signal,
      ...first,
    })
    const secondResult = await processResearchCycle({
      rawResponse: JSON.stringify(proposal),
      signal: new AbortController().signal,
      ...second,
    })

    expect(secondResult).toEqual(firstResult)
  })
})
