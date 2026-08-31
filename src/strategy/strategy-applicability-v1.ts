import { z } from "zod"

import {
  researchSnapshotIdV1Schema,
  researchSnapshotStrategyManifestV1Schema,
  researchSnapshotUtcTimestampV1Schema,
} from "../contracts/research-market-snapshot-v1.js"

export const STRATEGY_APPLICABILITY_VERSION = "1.0.0" as const
export const DIRECTIONAL_DEBIT_VERTICAL_APPLICABILITY_COMPONENT_ID =
  "assessDirectionalDebitVerticalApplicabilityV1" as const
export const DIRECTIONAL_DEBIT_VERTICAL_APPLICABILITY_COMPONENT_VERSION =
  "1.0.0" as const

export const STRATEGY_NOT_APPLICABLE_REASONS = Object.freeze([
  "SIGNAL_NOT_ACTIONABLE",
] as const)
export const STRATEGY_APPLICABILITY_UNAVAILABLE_REASONS = Object.freeze([
  "STRATEGY_MANIFEST_INCOMPATIBLE",
  "UNDERLYING_SNAPSHOT_INVALID",
  "FEATURE_INPUT_INVALID",
  "UNDERLYING_QUOTE_STALE",
  "LATEST_MINUTE_BAR_STALE",
] as const)

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const version = z.string().regex(/^\d+\.\d+\.\d+$/u)

const snapshotIdentitySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("VALIDATED"),
    strategyManifest: researchSnapshotStrategyManifestV1Schema,
    underlying: z.string().regex(/^[A-Z][A-Z0-9.]{0,15}$/u),
    underlyingSnapshotId: researchSnapshotIdV1Schema,
    evaluatedAt: researchSnapshotUtcTimestampV1Schema,
  }).strict(),
  z.object({
    status: z.literal("INVALID"),
    inputDigest: researchSnapshotIdV1Schema,
  }).strict(),
])

const identitySchema = z
  .object({
    evaluatedStrategyManifest: researchSnapshotStrategyManifestV1Schema.nullable(),
    featureComponentId: identifier,
    featureVersion: version,
    applicabilityComponentId: identifier,
    applicabilityComponentVersion: version,
    snapshot: snapshotIdentitySchema,
  })
  .strict()

const base = {
  applicabilityVersion: z.literal(STRATEGY_APPLICABILITY_VERSION),
  identity: identitySchema,
} as const

export const strategyApplicabilityV1Schema = z.discriminatedUnion("status", [
  z.object({
    ...base,
    status: z.literal("APPLICABLE"),
  }).strict(),
  z.object({
    ...base,
    status: z.literal("NOT_APPLICABLE"),
    reason: z.enum(STRATEGY_NOT_APPLICABLE_REASONS),
  }).strict(),
  z.object({
    ...base,
    status: z.literal("UNAVAILABLE"),
    reason: z.enum(STRATEGY_APPLICABILITY_UNAVAILABLE_REASONS),
  }).strict(),
])

export type StrategyApplicabilityV1 = Readonly<
  z.infer<typeof strategyApplicabilityV1Schema>
>
