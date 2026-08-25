import { z } from "zod"

export const RESEARCH_DECISION_CONTRACT_VERSION = "1.0.0" as const
export const STRATEGY_VERSION = "1.0.0" as const

export const NO_ACTION_REASON_CODES = [
  "MARKET_WINDOW_INELIGIBLE",
  "ACCOUNT_STATE_INELIGIBLE",
  "POSITION_OR_RISK_LIMIT_ACTIVE",
  "INSUFFICIENT_UNDERLYING_DATA",
  "REQUIRED_ALPACA_DATA_INVALID",
  "SIGNAL_NOT_ACTIONABLE",
  "NO_ELIGIBLE_SPREAD",
  "CANDIDATE_CHANGED",
  "EXACT_RISK_INPUTS_UNAVAILABLE",
  "CONTRACT_UNREPRESENTABLE",
] as const

const boundedText = z.string().trim().min(1).max(2_000)
const boundedIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const SPY_OPTION_SYMBOL_PATTERN = /^SPY(\d{6})([CP])(\d{8})$/u
const OCC_EXPIRATION_CENTURY_PREFIX = "20"
const contractSymbol = z.string().regex(SPY_OPTION_SYMBOL_PATTERN)
// OCC symbols encode a two-digit year. This contract only accepts 2000–2099
// so a full ISO date maps to exactly one symbol expiration.
const expirationDate = z.iso.date().refine((value) => {
  const year = Number(value.slice(0, 4))
  return year >= 2000 && year <= 2099
})
// Millisecond precision matches Date.parse, so sub-ms fractions cannot
// collapse distinct instants into the same freshness comparison.
const timestamp = z.iso.datetime({ offset: true, precision: 3 })

const sourcedFactSchema = z
  .object({
    claimId: boundedIdentifier,
    kind: z.literal("SOURCED_FACT"),
    claim: boundedText,
    snapshotRef: boundedIdentifier,
    locator: z.string().trim().min(1).max(512).optional(),
  })
  .strict()

const inferenceSchema = z
  .object({
    claimId: boundedIdentifier,
    kind: z.literal("INFERENCE"),
    claim: boundedText,
    basedOn: z.array(boundedIdentifier).min(1).max(32),
  })
  .strict()

const evidenceClaimSchema = z.discriminatedUnion("kind", [
  sourcedFactSchema,
  inferenceSchema,
])

const optionLegSchema = z
  .object({
    contractSymbol,
    strike: z.number().finite().positive(),
  })
  .strict()

/**
 * Parses the expiration, option type, and strike encoded in a SPY OCC symbol.
 *
 * @param symbol - SPY option contract symbol in OCC format.
 * @returns Parsed contract fields, or `undefined` when the symbol is malformed.
 */
const parseOptionContractSymbol = (symbol: string) => {
  const match = SPY_OPTION_SYMBOL_PATTERN.exec(symbol)
  if (match === null) return undefined

  const [, expiration, optionType, strike] = match
  if (expiration === undefined || optionType === undefined || strike === undefined) {
    return undefined
  }

  return {
    expiration: `${OCC_EXPIRATION_CENTURY_PREFIX}${expiration.slice(0, 2)}-${expiration.slice(2, 4)}-${expiration.slice(4, 6)}`,
    optionType,
    strike: Number(strike) / 1_000,
  }
}

const candidateSchema = z
  .object({
    underlying: z.literal("SPY"),
    structure: z.enum(["BULL_CALL_SPREAD", "BEAR_PUT_SPREAD"]),
    expiration: expirationDate,
    longLeg: optionLegSchema,
    shortLeg: optionLegSchema,
  })
  .strict()

// Keep the safe branch permissive so irrelevant prose cannot block NO_ACTION.
const noActionDecisionV1Schema = z
  .object({
    contractVersion: z.literal(RESEARCH_DECISION_CONTRACT_VERSION),
    strategyVersion: z.literal(STRATEGY_VERSION),
    outcome: z.literal("NO_ACTION"),
    reasonCodes: z.array(z.enum(NO_ACTION_REASON_CODES)).min(1),
    evidence: z.array(evidenceClaimSchema).max(64).optional().default([]),
  })
  .strip()

// Proposals are strict because retained unknown fields could be mistaken for trusted data.
const proposedTradeDecisionV1Schema = z
  .object({
    contractVersion: z.literal(RESEARCH_DECISION_CONTRACT_VERSION),
    strategyVersion: z.literal(STRATEGY_VERSION),
    outcome: z.literal("PROPOSE_TRADE"),
    direction: z.enum(["BULLISH", "BEARISH"]),
    thesis: boundedText,
    candidate: candidateSchema,
    invalidation: z.array(boundedText).min(1).max(16),
    evidence: z.array(evidenceClaimSchema).min(1).max(64),
  })
  .strict()
  .superRefine((decision, refinement) => {
    const expectedStructure =
      decision.direction === "BULLISH" ? "BULL_CALL_SPREAD" : "BEAR_PUT_SPREAD"
    if (decision.candidate.structure !== expectedStructure) {
      refinement.addIssue({
        code: "custom",
        path: ["candidate", "structure"],
        message: "The candidate structure does not match the proposed direction",
      })
    }

    const strikesAreOrdered =
      decision.candidate.structure === "BULL_CALL_SPREAD"
        ? decision.candidate.longLeg.strike < decision.candidate.shortLeg.strike
        : decision.candidate.longLeg.strike > decision.candidate.shortLeg.strike
    if (!strikesAreOrdered) {
      refinement.addIssue({
        code: "custom",
        path: ["candidate"],
        message: "The option strikes are not ordered for the proposed structure",
      })
    }

    if (
      decision.candidate.longLeg.contractSymbol ===
      decision.candidate.shortLeg.contractSymbol
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["candidate", "shortLeg", "contractSymbol"],
        message: "The spread legs must identify different contracts",
      })
    }

    // Cross-check redundant leg fields so downstream code receives one identity.
    const expectedOptionType =
      decision.candidate.structure === "BULL_CALL_SPREAD" ? "C" : "P"

    for (const [legName, leg] of [
      ["longLeg", decision.candidate.longLeg],
      ["shortLeg", decision.candidate.shortLeg],
    ] as const) {
      const parsedSymbol = parseOptionContractSymbol(leg.contractSymbol)
      if (
        parsedSymbol === undefined ||
        parsedSymbol.expiration !== decision.candidate.expiration ||
        parsedSymbol.optionType !== expectedOptionType ||
        parsedSymbol.strike !== leg.strike
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["candidate", legName, "contractSymbol"],
          message: "The contract symbol does not match the candidate leg",
        })
      }
    }

    if (!decision.evidence.some(({ kind }) => kind === "SOURCED_FACT")) {
      refinement.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A trade proposal requires at least one sourced fact",
      })
    }
  })

export const researchDecisionV1Schema = z.discriminatedUnion("outcome", [
  noActionDecisionV1Schema,
  proposedTradeDecisionV1Schema,
])

export type ResearchDecisionV1 = z.infer<typeof researchDecisionV1Schema>
export type NoActionDecisionV1 = z.infer<typeof noActionDecisionV1Schema>
export type ProposedTradeDecisionV1 = z.infer<typeof proposedTradeDecisionV1Schema>

const evidenceSnapshotMetadataSchema = z
  .object({
    provider: z.enum(["ALPACA", "FMP", "EXA"]),
    source: z.string().trim().min(1).max(128),
    retrievedAt: timestamp,
    freshUntil: timestamp,
  })
  .strict()
  .superRefine((snapshot, refinement) => {
    if (Date.parse(snapshot.freshUntil) < Date.parse(snapshot.retrievedAt)) {
      refinement.addIssue({
        code: "custom",
        path: ["freshUntil"],
        message: "Snapshot freshness cannot end before retrieval",
      })
    }
  })

export type EvidenceSnapshotMetadata = Readonly<
  z.infer<typeof evidenceSnapshotMetadataSchema>
>

export type ResearchDecisionValidationContext = Readonly<{
  evaluatedAt: string
  snapshots: Readonly<Record<string, EvidenceSnapshotMetadata>>
}>

export type ResearchDecisionValidationIssueCode =
  | "SCHEMA_INVALID"
  | "CONTEXT_INVALID"
  | "DUPLICATE_CLAIM_ID"
  | "UNKNOWN_SNAPSHOT"
  | "SNAPSHOT_FROM_FUTURE"
  | "STALE_SNAPSHOT"
  | "UNKNOWN_INFERENCE_REFERENCE"
  | "INFERENCE_REFERENCE_NOT_FACT"

export type ResearchDecisionValidationIssue = {
  code: ResearchDecisionValidationIssueCode
  path: readonly (string | number)[]
}

export type ResearchDecisionValidationResult =
  | {
      success: true
      data: ResearchDecisionV1
    }
  | {
      success: false
      issues: readonly ResearchDecisionValidationIssue[]
    }

const validationContextSchema = z
  .object({
    evaluatedAt: timestamp,
    snapshots: z.record(boundedIdentifier, evidenceSnapshotMetadataSchema),
  })
  .strict()

/**
 * Converts a Zod issue path into the bounded path type exposed to callers.
 *
 * @param path - Property keys reported by Zod for a validation issue.
 * @returns A path containing only strings and numeric indexes.
 */
const schemaIssuePath = (path: readonly PropertyKey[]) =>
  path.map((part) => (typeof part === "symbol" ? String(part) : part))

/**
 * Validates untrusted agent output against the v1 contract and trusted evidence
 * metadata.
 *
 * Context is validated first because model claims must never establish their
 * own provider identity, retrieval time, or freshness. Failures expose only
 * bounded codes and paths and never return the raw input.
 *
 * @param input - Untrusted candidate decision emitted by the research agent.
 * @param context - Application-owned evaluation time and snapshot metadata.
 * @returns The normalized decision on success, or bounded validation issues.
 */
export function validateResearchDecisionV1(
  input: unknown,
  context: ResearchDecisionValidationContext,
): ResearchDecisionValidationResult {
  // Reject invalid trusted metadata before inspecting model-authored references.
  const parsedContext = validationContextSchema.safeParse(context)
  if (!parsedContext.success) {
    return {
      success: false,
      issues: parsedContext.error.issues.map(({ path }) => ({
        code: "CONTEXT_INVALID",
        path: schemaIssuePath(path),
      })),
    }
  }

  const parsedDecision = researchDecisionV1Schema.safeParse(input)
  if (!parsedDecision.success) {
    return {
      success: false,
      issues: parsedDecision.error.issues.map(({ path }) => ({
        code: "SCHEMA_INVALID",
        path: schemaIssuePath(path),
      })),
    }
  }

  const issues: ResearchDecisionValidationIssue[] = []
  const claims = new Map<
    string,
    ResearchDecisionV1["evidence"][number]["kind"]
  >()

  // First index claim kinds and reject ambiguous identifiers.
  parsedDecision.data.evidence.forEach((evidence, index) => {
    if (claims.has(evidence.claimId)) {
      issues.push({
        code: "DUPLICATE_CLAIM_ID",
        path: ["evidence", index, "claimId"],
      })
      return
    }
    claims.set(evidence.claimId, evidence.kind)
  })

  const evaluatedAt = Date.parse(parsedContext.data.evaluatedAt)

  // Then resolve inference edges and evaluate sourced facts against trusted time.
  parsedDecision.data.evidence.forEach((evidence, index) => {
    if (evidence.kind === "INFERENCE") {
      evidence.basedOn.forEach((claimId, referenceIndex) => {
        const referencedKind = claims.get(claimId)
        if (referencedKind === undefined) {
          issues.push({
            code: "UNKNOWN_INFERENCE_REFERENCE",
            path: ["evidence", index, "basedOn", referenceIndex],
          })
        } else if (referencedKind !== "SOURCED_FACT") {
          issues.push({
            code: "INFERENCE_REFERENCE_NOT_FACT",
            path: ["evidence", index, "basedOn", referenceIndex],
          })
        }
      })
      return
    }

    // Only own snapshot keys are trusted. Inherited names such as
    // "constructor" would otherwise resolve to Object.prototype and skip
    // freshness checks because Date.parse(undefined) is NaN.
    const snapshot = Object.hasOwn(
      parsedContext.data.snapshots,
      evidence.snapshotRef,
    )
      ? parsedContext.data.snapshots[evidence.snapshotRef]
      : undefined
    if (snapshot === undefined) {
      issues.push({
        code: "UNKNOWN_SNAPSHOT",
        path: ["evidence", index, "snapshotRef"],
      })
      return
    }

    if (Date.parse(snapshot.retrievedAt) > evaluatedAt) {
      issues.push({
        code: "SNAPSHOT_FROM_FUTURE",
        path: ["evidence", index, "snapshotRef"],
      })
    }
    if (Date.parse(snapshot.freshUntil) < evaluatedAt) {
      issues.push({
        code: "STALE_SNAPSHOT",
        path: ["evidence", index, "snapshotRef"],
      })
    }
  })

  return issues.length === 0
    ? { success: true, data: parsedDecision.data }
    : { success: false, issues }
}