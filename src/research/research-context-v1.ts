import { randomUUID } from "node:crypto"

import {
  LEDGER_EVENT_TYPES,
  type LedgerEventV1,
  type StoredLedgerEventV1,
} from "../event-ledger/ledger-event-v1.js"
import type { LedgerStore } from "../event-ledger/ledger-store.js"
import type { PreliminaryResearchV2 } from "../contracts/preliminary-research-v2.js"
import type { AllowedOptionUnderlyingV1 } from "../shared/alpaca-option-identity.js"

/** Ledger query window: how much history is read, not how much survives. */
export const MAX_RESEARCH_CONTEXT_EVENTS = 500
/** The only budget on the projection itself. Every field below is prompt text. */
export const MAX_RESEARCH_CONTEXT_SERIALIZED_BYTES = 32 * 1024

const RECONSTRUCTION_PAGE_SIZE = 500
const TERMINAL_EVENT_TYPES = [
  "RESEARCH_CYCLE_STARTED",
  "RESEARCH_CYCLE_COMPLETED",
  "RESEARCH_CYCLE_INTERRUPTED",
] as const
const RESEARCH_CONTEXT_EVENT_TYPES = LEDGER_EVENT_TYPES

type TerminalStatus = Extract<
  LedgerEventV1,
  { eventType: "RESEARCH_CYCLE_COMPLETED" }
>["payload"]["status"]
type InterruptionReason = Extract<
  LedgerEventV1,
  { eventType: "RESEARCH_CYCLE_INTERRUPTED" }
>["payload"]["reason"]
type RejectionSource =
  | "NO_ACTION"
  | "DECISION_VALIDATION"
  | "INTENT_DERIVATION"

export type ResearchContextTerminalOutcomeV1 = Readonly<{
  cycleId: string
  cycleNumber?: number
  occurredAt: string
  status: TerminalStatus
}>

export type ResearchContextProposalV1 = Readonly<{
  cycleId: string
  direction: "BULLISH" | "BEARISH"
  underlying: AllowedOptionUnderlyingV1
  structure: "BULL_CALL_SPREAD" | "BEAR_PUT_SPREAD"
  expiration: string
  longContractSymbol: string
  shortContractSymbol: string
}>

export type ResearchContextRejectionCountV1 = Readonly<{
  code: string
  count: number
  sources: readonly RejectionSource[]
}>

export type ResearchContextEvidenceReferenceV1 = Readonly<{
  cycleId: string
  snapshotRef: string
  provider: "ALPACA" | "FMP" | "EXA"
  source: string
  retrievedAt: string
  freshUntil: string
  temporalClass?: "LIVE" | "DELAYED" | "PRIOR_CLOSE"
}>

export type ResearchContextInterruptionV1 = Readonly<{
  cycleId: string
  cycleNumber?: number
  occurredAt: string
  reason: InterruptionReason
}>

export type ResearchContextRefreshMarkerV1 = Readonly<{
  cycleId: string
  reason: "STALE_EVIDENCE" | "INTERRUPTED_CYCLE" | "PRELIMINARY_RESEARCH"
  snapshotRef?: string
}>

export type ResearchContextPreliminaryResearchV2 = Readonly<{
  cycleId: string
  occurredAt: string
  targetSessionDate: string
  direction: PreliminaryResearchV2["direction"]
  candidate?: PreliminaryResearchV2["candidate"]
  /**
   * Counts and provenance only. The model authors `claimId`, and this payload
   * re-enters a later prompt, so the identifier string is deliberately not
   * carried: nothing downstream reads it, and it is the one field here that
   * could smuggle model-authored text back in.
   */
  sourcedObservations: readonly Readonly<{
    provider: "ALPACA" | "FMP" | "EXA"
    temporalClass: "LIVE" | "DELAYED" | "PRIOR_CLOSE"
    observedAt: string
  }>[]
  requiresRefresh: true
}>

export type ResearchContextV1 = Readonly<{
  generatedAt: string
  nextCycleNumber: number
  latestValidatedProposal?: ResearchContextProposalV1
  latestPreliminaryResearch?: ResearchContextPreliminaryResearchV2
  recentTerminalOutcomes: readonly ResearchContextTerminalOutcomeV1[]
  recurringRejectionCounts: readonly ResearchContextRejectionCountV1[]
  evidenceReferences: Readonly<
    Record<string, ResearchContextEvidenceReferenceV1>
  >
  recentInterruptions: readonly ResearchContextInterruptionV1[]
  requiredRefreshes: readonly ResearchContextRefreshMarkerV1[]
  /** Older memory was dropped; treat retained history as incomplete. */
  truncatedBefore: boolean
}>

export type ProjectResearchContextV1Options = Readonly<{
  generatedAt: string
  truncatedBefore?: boolean
  latestCycleNumber?: number
}>

export type LoadResearchContextV1Options = Readonly<{
  generatedAt?: string
}>

export type ReconstructResearchContextV1Options = Readonly<{
  createEventId?: (startedEvent: LedgerEventV1, recoveryIndex: number) => string
  now?: () => Date
}>

type SequencedEvidenceReference = ResearchContextEvidenceReferenceV1 & {
  key: string
  sequence: number
}
type SequencedRefreshMarker = ResearchContextRefreshMarkerV1 & {
  sequence: number
}

const utf8Bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8")

/** Creates the collision-free key used by the normalized evidence-reference map. */
export const researchContextEvidenceKey = (
  cycleId: string,
  snapshotRef: string,
) => `${encodeURIComponent(cycleId)}+${encodeURIComponent(snapshotRef)}`

/**
 * Projects compact, non-prose research memory from a bounded ledger window.
 */
export function projectResearchContextV1(
  inputEvents: readonly StoredLedgerEventV1[],
  options: ProjectResearchContextV1Options,
): ResearchContextV1 {
  const generatedAt = Date.parse(options.generatedAt)
  if (!Number.isFinite(generatedAt)) {
    throw new Error("Research context generation time is invalid")
  }

  const orderedInput = [...inputEvents].sort(
    (left, right) => left.sequence - right.sequence,
  )
  const events = orderedInput.slice(-MAX_RESEARCH_CONTEXT_EVENTS)
  let truncatedBefore =
    options.truncatedBefore === true ||
    orderedInput.length > MAX_RESEARCH_CONTEXT_EVENTS
  const cycleNumbers = new Map<string, number>()
  let latestCycleNumber = options.latestCycleNumber ?? 0
  let latestValidatedProposal:
    | (ResearchContextProposalV1 & { sequence: number })
    | undefined
  let latestPreliminaryResearch:
    | (ResearchContextPreliminaryResearchV2 & { sequence: number })
    | undefined
  const terminalOutcomes: Array<ResearchContextTerminalOutcomeV1 & {
    sequence: number
  }> = []
  const interruptions: Array<ResearchContextInterruptionV1 & {
    sequence: number
  }> = []
  const rejectionCounts = new Map<
    string,
    { count: number; sources: Set<RejectionSource> }
  >()
  const evidenceReferences = new Map<string, SequencedEvidenceReference>()

  const countRejection = (code: string, source: RejectionSource) => {
    const existing = rejectionCounts.get(code) ?? {
      count: 0,
      sources: new Set<RejectionSource>(),
    }
    existing.count += 1
    existing.sources.add(source)
    rejectionCounts.set(code, existing)
  }

  for (const event of events) {
    const cycleId = event.cycleId
    if (event.eventType === "RESEARCH_CYCLE_STARTED") {
      if (cycleId !== undefined) {
        cycleNumbers.set(cycleId, event.payload.cycleNumber)
      }
      latestCycleNumber = Math.max(latestCycleNumber, event.payload.cycleNumber)
      continue
    }
    if (cycleId === undefined) continue

    if (event.eventType === "RESEARCH_CYCLE_COMPLETED") {
      const cycleNumber = cycleNumbers.get(cycleId)
      terminalOutcomes.push({
        cycleId,
        ...(cycleNumber === undefined ? {} : { cycleNumber }),
        occurredAt: event.occurredAt,
        status: event.payload.status,
        sequence: event.sequence,
      })
      continue
    }
    if (event.eventType === "RESEARCH_CYCLE_INTERRUPTED") {
      const cycleNumber = cycleNumbers.get(cycleId)
      interruptions.push({
        cycleId,
        ...(cycleNumber === undefined ? {} : { cycleNumber }),
        occurredAt: event.occurredAt,
        reason: event.payload.reason,
        sequence: event.sequence,
      })
      continue
    }
    if (event.eventType === "EVIDENCE_SNAPSHOT_REFERENCED") {
      const key = researchContextEvidenceKey(cycleId, event.payload.snapshotRef)
      evidenceReferences.set(key, {
        key,
        cycleId,
        snapshotRef: event.payload.snapshotRef,
        provider: event.payload.provider,
        source: event.payload.source,
        retrievedAt: event.payload.retrievedAt,
        freshUntil: event.payload.freshUntil,
        ...(event.payload.temporalClass === undefined
          ? {}
          : { temporalClass: event.payload.temporalClass }),
        sequence: event.sequence,
      })
      continue
    }
    if (event.eventType === "PRELIMINARY_RESEARCH_RECORDED") {
      latestPreliminaryResearch = {
        cycleId,
        occurredAt: event.occurredAt,
        targetSessionDate: event.payload.research.targetSessionDate,
        direction: event.payload.research.direction,
        ...(event.payload.research.candidate === undefined
          ? {}
          : { candidate: event.payload.research.candidate }),
        sourcedObservations: event.payload.research.evidence
          .filter((claim) => claim.kind === "SOURCED_FACT")
          .map(({ provider, temporalClass, observedAt }) => ({
            provider,
            temporalClass,
            observedAt,
          })),
        requiresRefresh: true,
        sequence: event.sequence,
      }
      continue
    }
    if (event.eventType === "RESEARCH_DECISION_REJECTED") {
      for (const issue of event.payload.issues) {
        countRejection(issue.code, "DECISION_VALIDATION")
      }
      continue
    }
    if (event.eventType === "TRADE_INTENT_DERIVATION_REJECTED") {
      for (const reason of event.payload.reasons) {
        countRejection(reason, "INTENT_DERIVATION")
      }
      continue
    }
    if (event.eventType !== "RESEARCH_DECISION_VALIDATED") continue

    const decision = event.payload.decision
    if (decision.outcome === "NO_ACTION") {
      for (const reason of decision.reasonCodes) {
        countRejection(reason, "NO_ACTION")
      }
      continue
    }
    latestValidatedProposal = {
      cycleId,
      direction: decision.direction,
      underlying: decision.candidate.underlying,
      structure: decision.candidate.structure,
      expiration: decision.candidate.expiration,
      longContractSymbol: decision.candidate.longLeg.contractSymbol,
      shortContractSymbol: decision.candidate.shortLeg.contractSymbol,
      sequence: event.sequence,
    }
  }

  const pendingPreliminaryResearch =
    latestPreliminaryResearch !== undefined &&
    (latestValidatedProposal === undefined ||
      latestPreliminaryResearch.sequence > latestValidatedProposal.sequence)
      ? latestPreliminaryResearch
      : undefined

  const newestFirst = <T extends { sequence: number }>(values: readonly T[]) =>
    [...values].sort((left, right) => right.sequence - left.sequence)
  let retainedOutcomes = newestFirst(terminalOutcomes)
  let retainedInterruptions = newestFirst(interruptions)
  let retainedEvidence = newestFirst([...evidenceReferences.values()])
  let retainedRejections: ResearchContextRejectionCountV1[] = [
    ...rejectionCounts.entries(),
  ]
    .map(([code, count]) => ({
      code,
      count: count.count,
      sources: [...count.sources].sort(),
    }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
  let retainedRefreshes: SequencedRefreshMarker[] = [
    ...(pendingPreliminaryResearch === undefined
      ? []
      : [
          {
            cycleId: pendingPreliminaryResearch.cycleId,
            reason: "PRELIMINARY_RESEARCH" as const,
            sequence: pendingPreliminaryResearch.sequence,
          },
        ]),
    ...retainedEvidence
      .filter(({ freshUntil }) => Date.parse(freshUntil) < generatedAt)
      .map(({ cycleId, snapshotRef, sequence }) => ({
        cycleId,
        snapshotRef,
        reason: "STALE_EVIDENCE" as const,
        sequence,
      })),
    ...retainedInterruptions.map(({ cycleId, sequence }) => ({
      cycleId,
      reason: "INTERRUPTED_CYCLE" as const,
      sequence,
    })),
  ]
    .sort(
      (left, right) =>
        right.sequence - left.sequence ||
        left.cycleId.localeCompare(right.cycleId) ||
        left.reason.localeCompare(right.reason),
    )

  const assemble = () => {
    const references = Object.fromEntries(
      retainedEvidence.map(({ key, sequence: _sequence, ...reference }) => [
        key,
        reference,
      ]),
    )
    const value = {
      generatedAt: options.generatedAt,
      nextCycleNumber: latestCycleNumber + 1,
      ...(latestValidatedProposal === undefined
        ? {}
        : {
            latestValidatedProposal: {
              cycleId: latestValidatedProposal.cycleId,
              direction: latestValidatedProposal.direction,
              underlying: latestValidatedProposal.underlying,
              structure: latestValidatedProposal.structure,
              expiration: latestValidatedProposal.expiration,
              longContractSymbol: latestValidatedProposal.longContractSymbol,
              shortContractSymbol: latestValidatedProposal.shortContractSymbol,
            },
          }),
      ...(pendingPreliminaryResearch === undefined
        ? {}
        : {
            latestPreliminaryResearch: {
              cycleId: pendingPreliminaryResearch.cycleId,
              occurredAt: pendingPreliminaryResearch.occurredAt,
              targetSessionDate: pendingPreliminaryResearch.targetSessionDate,
              direction: pendingPreliminaryResearch.direction,
              ...(pendingPreliminaryResearch.candidate === undefined
                ? {}
                : { candidate: pendingPreliminaryResearch.candidate }),
              sourcedObservations:
                pendingPreliminaryResearch.sourcedObservations,
              requiresRefresh: true as const,
            },
          }),
      recentTerminalOutcomes: retainedOutcomes.map(
        ({ sequence: _sequence, ...outcome }) => outcome,
      ),
      recurringRejectionCounts: retainedRejections,
      evidenceReferences: references,
      recentInterruptions: retainedInterruptions.map(
        ({ sequence: _sequence, ...interruption }) => interruption,
      ),
      requiredRefreshes: retainedRefreshes.map(
        ({ sequence: _sequence, ...refresh }) => refresh,
      ),
      truncatedBefore,
    }
    return value
  }

  let context = assemble()
  // Trim the largest collection first rather than round-robin: taking one item
  // per collection per pass starves small collections (interruption history)
  // to their floor while a large one keeps most of its entries. Each closure
  // drops its oldest item and keeps at least one, so every kind of memory
  // survives in some form.
  const trimCollections = [
    {
      size: () => retainedEvidence.length,
      trim: () => {
        const removed = retainedEvidence.at(-1)
        retainedEvidence = retainedEvidence.slice(0, -1)
        if (removed !== undefined) {
          retainedRefreshes = retainedRefreshes.filter(
            (refresh) =>
              refresh.reason !== "STALE_EVIDENCE" ||
              refresh.cycleId !== removed.cycleId ||
              refresh.snapshotRef !== removed.snapshotRef,
          )
        }
      },
    },
    {
      size: () => retainedRefreshes.length,
      trim: () => {
        retainedRefreshes = retainedRefreshes.slice(0, -1)
      },
    },
    {
      size: () => retainedOutcomes.length,
      trim: () => {
        retainedOutcomes = retainedOutcomes.slice(0, -1)
      },
    },
    {
      size: () => retainedInterruptions.length,
      trim: () => {
        retainedInterruptions = retainedInterruptions.slice(0, -1)
      },
    },
    {
      size: () => retainedRejections.length,
      trim: () => {
        retainedRejections = retainedRejections.slice(0, -1)
      },
    },
  ]
  while (utf8Bytes(context) > MAX_RESEARCH_CONTEXT_SERIALIZED_BYTES) {
    const largest = trimCollections.reduce((left, right) =>
      right.size() > left.size() ? right : left,
    )
    if (largest.size() <= 1) {
      throw new Error("Research context cannot fit its serialized byte bound")
    }
    largest.trim()
    // Byte-bound trimming drops history just as the event window does, so the
    // agent must be told either way.
    truncatedBefore = true
    context = assemble()
  }

  return context
}

/** Loads only the newest bounded event window before projecting research context. */
export async function loadResearchContextV1(
  store: LedgerStore,
  options: LoadResearchContextV1Options = {},
): Promise<ResearchContextV1> {
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const [window, latestStart] = await Promise.all([
    store.list({
      direction: "DESC",
      eventTypes: RESEARCH_CONTEXT_EVENT_TYPES,
      limit: MAX_RESEARCH_CONTEXT_EVENTS + 1,
    }),
    store.list({
      direction: "DESC",
      eventTypes: ["RESEARCH_CYCLE_STARTED"],
      limit: 1,
    }),
  ])
  const events = window.slice(0, MAX_RESEARCH_CONTEXT_EVENTS)
  const latestCycleNumber =
    latestStart[0]?.eventType === "RESEARCH_CYCLE_STARTED"
      ? latestStart[0].payload.cycleNumber
      : undefined

  return projectResearchContextV1(events, {
    generatedAt,
    truncatedBefore: window.length > MAX_RESEARCH_CONTEXT_EVENTS,
    ...(latestCycleNumber === undefined ? {} : { latestCycleNumber }),
  })
}

/**
 * Closes cycles left open by a prior process, then rebuilds bounded context.
 */
export async function reconstructResearchContextV1(
  store: LedgerStore,
  options: ReconstructResearchContextV1Options = {},
): Promise<ResearchContextV1> {
  const createEventId = options.createEventId ?? (() => randomUUID())
  const reconstructedAt = (options.now ?? (() => new Date()))().toISOString()
  const openCycles = new Map<string, StoredLedgerEventV1>()
  let afterSequence = 0

  while (true) {
    const page = await store.list({
      afterSequence,
      direction: "ASC",
      eventTypes: TERMINAL_EVENT_TYPES,
      limit: RECONSTRUCTION_PAGE_SIZE,
    })
    if (page.length === 0) break

    for (const event of page) {
      if (event.cycleId === undefined) continue
      if (event.eventType === "RESEARCH_CYCLE_STARTED") {
        openCycles.set(event.cycleId, event)
      } else {
        openCycles.delete(event.cycleId)
      }
    }
    const lastSequence = page.at(-1)?.sequence
    if (lastSequence === undefined) break
    afterSequence = lastSequence
    if (page.length < RECONSTRUCTION_PAGE_SIZE) break
  }

  const starts = [...openCycles.values()].sort(
    (left, right) => left.sequence - right.sequence,
  )
  const interruptions: LedgerEventV1[] = starts.map((start, recoveryIndex) => {
    if (start.cycleId === undefined) {
      throw new Error("Research cycle start is missing its cycle identity")
    }
    return {
      eventId: createEventId(start, recoveryIndex),
      eventVersion: "1.0.0",
      eventType: "RESEARCH_CYCLE_INTERRUPTED",
      occurredAt: reconstructedAt,
      correlationId: start.correlationId,
      causationEventId: start.eventId,
      cycleId: start.cycleId,
      ...(start.sessionId === undefined ? {} : { sessionId: start.sessionId }),
      payload: { reason: "PROCESS_RESTART" },
    }
  })

  for (let offset = 0; offset < interruptions.length; offset += 1_000) {
    await store.appendBatch(interruptions.slice(offset, offset + 1_000))
  }

  return loadResearchContextV1(store, { generatedAt: reconstructedAt })
}
