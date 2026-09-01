import { z } from "zod"

import {
  ALLOWED_OPTION_UNDERLYINGS_V1,
  parseAlpacaOptionSymbol,
  allowedAlpacaOptionSymbolV1Schema,
  validateOptionUniverseV1,
} from "../shared/alpaca-option-identity.js"
import {
  safeSchemaDiagnostics,
  type SchemaViolationCategory,
} from "../shared/schema-diagnostics.js"
export const RESEARCH_DECISION_CONTRACT_VERSION = "2.0.0" as const

/**
 * Explicit order-leg vocabulary for downstream option-trading consumers.
 *
 * `direction` describes the broker instruction, not the market thesis. For
 * example, a bull call spread contains both BUY_CALL and SELL_CALL legs.
 * Keeping the side and option type in this application-owned dictionary lets
 * downstream code translate a validated decision without parsing enum names.
 */
export const OPTION_TRADE_DIRECTIONS = [
  "BUY_CALL",
  "BUY_PUT",
  "SELL_CALL",
  "SELL_PUT",
] as const

export const optionTradeDirectionSchema = z.enum(OPTION_TRADE_DIRECTIONS)

export type OptionTradeDirection = z.infer<typeof optionTradeDirectionSchema>

export const OPTION_TRADE_DIRECTION_DICTIONARY = {
  BUY_CALL: {
    orderSide: "BUY",
    optionType: "CALL",
    symbolOptionType: "C",
  },
  BUY_PUT: {
    orderSide: "BUY",
    optionType: "PUT",
    symbolOptionType: "P",
  },
  SELL_CALL: {
    orderSide: "SELL",
    optionType: "CALL",
    symbolOptionType: "C",
  },
  SELL_PUT: {
    orderSide: "SELL",
    optionType: "PUT",
    symbolOptionType: "P",
  },
} as const satisfies Readonly<
  Record<
    OptionTradeDirection,
    Readonly<{
      orderSide: "BUY" | "SELL"
      optionType: "CALL" | "PUT"
      symbolOptionType: "C" | "P"
    }>
  >
>

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
  "REQUIRED_EXA_EVIDENCE_UNAVAILABLE",
  "CONTRACT_UNREPRESENTABLE",
] as const

const boundedText = z.string().trim().min(1).max(2_000)
const boundedClaim = z.string().trim().min(1).max(500)
const boundedIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const contractSymbol = allowedAlpacaOptionSymbolV1Schema
// OCC symbols encode a two-digit year. This contract only accepts 2000–2099
// so a full ISO date maps to exactly one symbol expiration.
const expirationDate = z.iso.date().refine((value) => {
  const year = Number(value.slice(0, 4))
  return year >= 2000 && year <= 2099
})
// Millisecond precision matches Date.parse, so sub-ms fractions cannot
// collapse distinct instants into the same freshness comparison.
const timestamp = z.iso.datetime({ offset: true, precision: 3 })

export const MARKET_OBSERVATION_TEMPORAL_CLASSES = [
  "LIVE",
  "DELAYED",
  "PRIOR_CLOSE",
] as const

const agentReportedSourcedFactSchema = z
  .object({
    claimId: boundedIdentifier,
    kind: z.literal("SOURCED_FACT"),
    claim: boundedClaim,
    provider: z.enum(["ALPACA", "FMP", "EXA"]),
    temporalClass: z.enum(MARKET_OBSERVATION_TEMPORAL_CLASSES),
    observedAt: timestamp,
    locator: z.string().trim().min(1).max(512).optional(),
  })
  .strict()

const agentReportedInferenceSchema = z
  .object({
    claimId: boundedIdentifier,
    kind: z.literal("INFERENCE"),
    claim: boundedClaim,
    basedOn: z.array(boundedIdentifier).min(1).max(16),
  })
  .strict()

export const agentReportedEvidenceSchema = z
  .array(
    z.discriminatedUnion("kind", [
      agentReportedSourcedFactSchema,
      agentReportedInferenceSchema,
    ]),
  )
  .min(1)
  .max(16)
  .superRefine((evidence, refinement) => {
    const claimKinds = new Map<string, "SOURCED_FACT" | "INFERENCE">()
    evidence.forEach((claim, index) => {
      if (claimKinds.has(claim.claimId)) {
        refinement.addIssue({
          code: "custom",
          path: [index, "claimId"],
          message: "Agent-reported claim identifiers must be unique",
        })
      } else {
        claimKinds.set(claim.claimId, claim.kind)
      }
    })

    evidence.forEach((claim, index) => {
      if (claim.kind !== "INFERENCE") return
      claim.basedOn.forEach((claimId, referenceIndex) => {
        if (claimKinds.get(claimId) !== "SOURCED_FACT") {
          refinement.addIssue({
            code: "custom",
            path: [index, "basedOn", referenceIndex],
            message: "Agent-reported inferences must reference sourced facts",
          })
        }
      })
    })
  })

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

export const TRADING_DECISION_CONTRACT_VERSION = "1.0.0" as const

export const OPTION_TRADING_STRATEGIES = [
  "LONG_CALL",
  "LONG_PUT",
  "SHORT_CALL",
  "SHORT_PUT",
  "BULL_CALL_SPREAD",
  "BEAR_PUT_SPREAD",
] as const

export type OptionTradingStrategy =
  (typeof OPTION_TRADING_STRATEGIES)[number]

/**
 * Ordered leg directions for each supported strategy. Consumers should use
 * this dictionary instead of inferring an order side or option type from prose.
 */
export const OPTION_TRADING_STRATEGY_DICTIONARY = {
  LONG_CALL: ["BUY_CALL"],
  LONG_PUT: ["BUY_PUT"],
  SHORT_CALL: ["SELL_CALL"],
  SHORT_PUT: ["SELL_PUT"],
  BULL_CALL_SPREAD: ["BUY_CALL", "SELL_CALL"],
  BEAR_PUT_SPREAD: ["BUY_PUT", "SELL_PUT"],
} as const satisfies Readonly<
  Record<OptionTradingStrategy, readonly OptionTradeDirection[]>
>

const positiveContractQuantity = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)

/**
 * One normalized broker instruction. Ticker and redundant contract fields are
 * deliberately cross-checked against the compact Alpaca/OCC symbol so a
 * downstream order planner never needs to guess which asset a leg belongs to.
 *
 * Research may propose entries only. Position exits remain owned by the
 * deterministic exit-management stage in the application pipeline.
 */
export const optionTradingOrderLegV1Schema = z
  .object({
    legId: boundedIdentifier,
    ticker: z.enum(ALLOWED_OPTION_UNDERLYINGS_V1),
    direction: optionTradeDirectionSchema,
    positionEffect: z.literal("OPEN"),
    contractSymbol,
    expiration: expirationDate,
    strike: z.number().finite().positive(),
    quantity: positiveContractQuantity,
  })
  .strict()
  .superRefine((leg, refinement) => {
    const parsedSymbol = parseAlpacaOptionSymbol(leg.contractSymbol)
    const semantics = OPTION_TRADE_DIRECTION_DICTIONARY[leg.direction]
    if (
      !parsedSymbol.success ||
      !validateOptionUniverseV1(parsedSymbol.identity).success ||
      parsedSymbol.identity.root !== leg.ticker ||
      parsedSymbol.identity.expiration !== leg.expiration ||
      parsedSymbol.identity.optionType !== semantics.symbolOptionType ||
      parsedSymbol.identity.strikeThousandthsPerShare / 1_000 !== leg.strike
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["contractSymbol"],
        message:
          "The contract symbol must match the leg ticker, direction, expiration, and strike",
      })
    }
  })

export type OptionTradingOrderLegV1 = Readonly<
  z.infer<typeof optionTradingOrderLegV1Schema>
>

const proposedOptionTradingDecisionV1Schema = z
  .object({
    contractVersion: z.literal(TRADING_DECISION_CONTRACT_VERSION),
    outcome: z.literal("PROPOSE_TRADE"),
    decisionId: boundedIdentifier,
    ticker: z.enum(ALLOWED_OPTION_UNDERLYINGS_V1),
    strategy: z.enum(OPTION_TRADING_STRATEGIES),
    thesis: boundedText,
    orders: z.array(optionTradingOrderLegV1Schema).min(1).max(2),
    invalidation: z.array(boundedText).min(1).max(16),
    evidence: z.array(evidenceClaimSchema).min(1).max(64),
  })
  .strict()
  .superRefine((decision, refinement) => {
    const expectedDirections =
      OPTION_TRADING_STRATEGY_DICTIONARY[decision.strategy]

    if (
      decision.orders.length !== expectedDirections.length ||
      decision.orders.some(
        (order, index) => order.direction !== expectedDirections[index],
      )
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["orders"],
        message:
          "The ordered broker directions must match the selected strategy dictionary",
      })
    }

    decision.orders.forEach((order, index) => {
      if (order.ticker !== decision.ticker) {
        refinement.addIssue({
          code: "custom",
          path: ["orders", index, "ticker"],
          message: "Every order leg ticker must match the decision ticker",
        })
      }
    })

    if (new Set(decision.orders.map(({ legId }) => legId)).size !== decision.orders.length) {
      refinement.addIssue({
        code: "custom",
        path: ["orders"],
        message: "Order leg identifiers must be unique",
      })
    }

    if (decision.orders.length === 2) {
      const [longLeg, shortLeg] = decision.orders
      if (longLeg === undefined || shortLeg === undefined) return

      if (
        longLeg.expiration !== shortLeg.expiration ||
        longLeg.quantity !== shortLeg.quantity
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["orders"],
          message: "Vertical-spread legs must have equal quantity and expiration",
        })
      }

      const strikesAreOrdered =
        decision.strategy === "BULL_CALL_SPREAD"
          ? longLeg.strike < shortLeg.strike
          : decision.strategy === "BEAR_PUT_SPREAD"
            ? longLeg.strike > shortLeg.strike
            : false
      if (!strikesAreOrdered) {
        refinement.addIssue({
          code: "custom",
          path: ["orders"],
          message: "Vertical-spread strikes are not ordered for the strategy",
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

const noOptionTradingActionV1Schema = z
  .object({
    contractVersion: z.literal(TRADING_DECISION_CONTRACT_VERSION),
    outcome: z.literal("NO_ACTION"),
    reasonCodes: z
      .array(z.enum(NO_ACTION_REASON_CODES))
      .min(1)
      .max(NO_ACTION_REASON_CODES.length),
    evidence: agentReportedEvidenceSchema,
  })
  .strip()

/**
 * Research-to-validation decision dictionary. Passing this schema means only
 * that the proposal is structurally coherent; it does not authorize an order.
 * Offline audit, deterministic risk gates, and immutable order-plan creation
 * remain mandatory downstream stages.
 */
export const optionTradingDecisionV1Schema = z.discriminatedUnion("outcome", [
  noOptionTradingActionV1Schema,
  proposedOptionTradingDecisionV1Schema,
])

export type OptionTradingDecisionV1 = Readonly<
  z.infer<typeof optionTradingDecisionV1Schema>
>
export type ProposedOptionTradingDecisionV1 = Readonly<
  z.infer<typeof proposedOptionTradingDecisionV1Schema>
>

const optionLegSchema = z
  .object({
    contractSymbol,
    strike: z.number().finite().positive(),
  })
  .strict()

export const researchCandidateV2Schema = z
  .object({
    underlying: z.enum(ALLOWED_OPTION_UNDERLYINGS_V1),
    structure: z.enum(["BULL_CALL_SPREAD", "BEAR_PUT_SPREAD"]),
    expiration: expirationDate,
    longLeg: optionLegSchema,
    shortLeg: optionLegSchema,
  })
  .strict()
  .superRefine((candidate, refinement) => {
    const strikesAreOrdered =
      candidate.structure === "BULL_CALL_SPREAD"
        ? candidate.longLeg.strike < candidate.shortLeg.strike
        : candidate.longLeg.strike > candidate.shortLeg.strike
    if (!strikesAreOrdered) {
      refinement.addIssue({
        code: "custom",
        path: [],
        message: "The option strikes are not ordered for the proposed structure",
      })
    }

    if (candidate.longLeg.contractSymbol === candidate.shortLeg.contractSymbol) {
      refinement.addIssue({
        code: "custom",
        path: ["shortLeg", "contractSymbol"],
        message: "The spread legs must identify different contracts",
      })
    }

    // Cross-check redundant leg fields so every retained candidate has one identity.
    const expectedOptionType =
      candidate.structure === "BULL_CALL_SPREAD" ? "C" : "P"
    for (const [legName, leg] of [
      ["longLeg", candidate.longLeg],
      ["shortLeg", candidate.shortLeg],
    ] as const) {
      const parsedSymbol = parseAlpacaOptionSymbol(leg.contractSymbol)
      if (
        !parsedSymbol.success ||
        !validateOptionUniverseV1(parsedSymbol.identity).success ||
        parsedSymbol.identity.root !== candidate.underlying ||
        parsedSymbol.identity.expiration !== candidate.expiration ||
        parsedSymbol.identity.optionType !== expectedOptionType ||
        parsedSymbol.identity.strikeThousandthsPerShare / 1_000 !== leg.strike
      ) {
        refinement.addIssue({
          code: "custom",
          path: [legName, "contractSymbol"],
          message: "The contract symbol does not match the candidate leg",
        })
      }
    }
  })

// Keep the safe branch stripped so irrelevant prose cannot block NO_ACTION.
export const noActionDecisionV2Schema = z
  .object({
    contractVersion: z.literal(RESEARCH_DECISION_CONTRACT_VERSION),
    outcome: z.literal("NO_ACTION"),
    reasonCodes: z
      .array(z.enum(NO_ACTION_REASON_CODES))
      .min(1)
      .max(NO_ACTION_REASON_CODES.length),
    evidence: agentReportedEvidenceSchema,
  })
  .strip()

// Proposals are strict because retained unknown fields could be mistaken for trusted data.
export const proposedTradeDecisionV2Schema = z
  .object({
    contractVersion: z.literal(RESEARCH_DECISION_CONTRACT_VERSION),
    outcome: z.literal("PROPOSE_TRADE"),
    direction: z.enum(["BULLISH", "BEARISH"]),
    thesis: boundedText,
    candidate: researchCandidateV2Schema,
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

    if (!decision.evidence.some(({ kind }) => kind === "SOURCED_FACT")) {
      refinement.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A trade proposal requires at least one sourced fact",
      })
    }
  })

export const researchDecisionV2Schema = z.discriminatedUnion("outcome", [
  noActionDecisionV2Schema,
  proposedTradeDecisionV2Schema,
])

export type ResearchDecisionV2 = z.infer<typeof researchDecisionV2Schema>
export type NoActionDecisionV2 = z.infer<typeof noActionDecisionV2Schema>
export type ProposedTradeDecisionV2 = z.infer<typeof proposedTradeDecisionV2Schema>
export type ResearchCandidateV2 = z.infer<typeof researchCandidateV2Schema>

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
  schemaCategory?: SchemaViolationCategory
}

export type ResearchDecisionValidationResult =
  | {
      success: true
      data: ResearchDecisionV2
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
 * Validates untrusted agent output against the v2 contract and trusted evidence
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
export function validateResearchDecisionV2(
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

  const parsedDecision = researchDecisionV2Schema.safeParse(input)
  if (!parsedDecision.success) {
    return {
      success: false,
      issues: safeSchemaDiagnostics(parsedDecision.error.issues, input),
    }
  }

  // NO_ACTION evidence is explicitly agent-reported; only proposal evidence
  // may claim application-owned snapshot verification.
  if (parsedDecision.data.outcome === "NO_ACTION") {
    return { success: true, data: parsedDecision.data }
  }

  const issues: ResearchDecisionValidationIssue[] = []
  const claims = new Map<string, "SOURCED_FACT" | "INFERENCE">()

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
