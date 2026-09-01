import { z } from "zod"

import { shadowRiskDecisionV1Schema } from "../risk/shadow-risk-v1.js"
import { canonicalJson, canonicalJsonSha256 } from "../shared/canonical-json.js"
import type { LedgerStore } from "../event-ledger/ledger-store.js"

export const EXECUTION_AUTHORIZATION_VERSION = "1.0.0" as const
export const EXECUTION_ACCOUNT = "ALPACA_PAPER" as const

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const positiveMoney = z.string().regex(/^(?:0\.(?:0[1-9]|[1-9]\d)|[1-9]\d*\.\d{2})$/u)

const executionOrderLegV1Schema = z
  .object({
    symbol: z.string().regex(/^[A-Z0-9]{1,6}\d{6}[CP]\d{8}$/u),
    ratio_qty: z.string().regex(/^[1-9]\d*$/u),
    side: z.enum(["buy", "sell"]),
    position_intent: z.enum(["buy_to_open", "sell_to_open"]),
  })
  .strict()

export const executionAuthorizationV1Schema = z
  .object({
    authorizationVersion: z.literal(EXECUTION_AUTHORIZATION_VERSION),
    authorizationId: identifier,
    account: z.literal(EXECUTION_ACCOUNT),
    issuedAt: timestamp,
    expiresAt: timestamp,
    sourceIntentSha256: sha256,
    sourceRiskDecisionSha256: sha256,
    order: z
      .object({
        qty: z.literal("1"),
        type: z.literal("limit"),
        time_in_force: z.literal("day"),
        limit_price: positiveMoney,
        client_order_id: identifier,
        order_class: z.literal("mleg"),
        legs: z.array(executionOrderLegV1Schema).min(2).max(4),
      })
      .strict(),
  })
  .strict()
  .refine(
    ({ issuedAt, expiresAt }) => Date.parse(issuedAt) < Date.parse(expiresAt),
    { path: ["expiresAt"], message: "Authorization must expire after issuance" },
  )

export type ExecutionAuthorizationV1 = Readonly<
  z.infer<typeof executionAuthorizationV1Schema>
>

export type DeriveExecutionAuthorizationV1Input = Readonly<{
  authorizationId: string
  issuedAt: string
  expiresAt: string
  riskDecision: unknown
}>

const centsToDollars = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`

/** Derives the exact paper-order instruction from one approved refreshed intent. */
export function deriveExecutionAuthorizationV1({
  authorizationId,
  issuedAt,
  expiresAt,
  riskDecision,
}: DeriveExecutionAuthorizationV1Input): ExecutionAuthorizationV1 | undefined {
  const parsed = shadowRiskDecisionV1Schema.safeParse(riskDecision)
  if (
    !parsed.success ||
    parsed.data.stage !== "EVALUATED" ||
    parsed.data.outcome !== "APPROVED" ||
    parsed.data.evaluation.outcome !== "APPROVED" ||
    parsed.data.evaluatedIntent.contractVersion !== "4.0.0" ||
    parsed.data.evaluatedIntent.premiumEffect !== "DEBIT" ||
    parsed.data.evaluatedIntent.legs.length < 2 ||
    Date.parse(issuedAt) >= Date.parse(expiresAt)
  ) return undefined

  const intent = parsed.data.evaluatedIntent
  const authorization = executionAuthorizationV1Schema.safeParse({
    authorizationVersion: EXECUTION_AUTHORIZATION_VERSION,
    authorizationId,
    account: EXECUTION_ACCOUNT,
    issuedAt,
    expiresAt,
    sourceIntentSha256: canonicalJsonSha256(intent),
    sourceRiskDecisionSha256: canonicalJsonSha256(parsed.data),
    order: {
      qty: String(parsed.data.evaluation.approvedQuantity),
      type: "limit",
      time_in_force: "day",
      limit_price: centsToDollars(intent.entryLimitCentsPerStrategyUnit),
      client_order_id: `gitl-${canonicalJsonSha256(authorizationId).slice(0, 32)}`,
      order_class: "mleg",
      legs: intent.legs.map((leg) => ({
        symbol: leg.contractSymbol,
        ratio_qty: String(leg.ratioQuantity),
        side: leg.positionIntent === "BUY_TO_OPEN" ? "buy" : "sell",
        position_intent:
          leg.positionIntent === "BUY_TO_OPEN" ? "buy_to_open" : "sell_to_open",
      })),
    },
  })
  return authorization.success ? authorization.data : undefined
}

export const EXECUTION_AUTHORIZATION_FAILURE_CODES = [
  "AUTHORIZATION_NOT_FOUND",
  "AUTHORIZATION_INVALID",
  "AUTHORIZATION_NOT_ACTIVE",
] as const

export type ExecutionAuthorizationResolutionV1 =
  | Readonly<{
      status: "AUTHORIZED"
      eventId: string
      authorization: ExecutionAuthorizationV1
    }>
  | Readonly<{
      status: "NOT_AUTHORIZED"
      reasonCodes: readonly (typeof EXECUTION_AUTHORIZATION_FAILURE_CODES)[number][]
    }>

/** Resolves and re-derives a ledger authorization without trusting its payload alone. */
export async function resolveExecutionAuthorizationV1(
  store: LedgerStore,
  authorizationId: string,
  now: Date = new Date(),
): Promise<ExecutionAuthorizationResolutionV1> {
  if (!identifier.safeParse(authorizationId).success) {
    return { status: "NOT_AUTHORIZED", reasonCodes: ["AUTHORIZATION_NOT_FOUND"] }
  }
  const events = await store.list({
    cycleId: authorizationId,
    eventTypes: ["EXECUTION_AUTHORIZATION_RECORDED"],
    limit: 2,
  })
  const event = events[0]
  if (
    events.length !== 1 ||
    event?.eventType !== "EXECUTION_AUTHORIZATION_RECORDED" ||
    event.eventVersion !== "4.0.0" ||
    event.payload.instruction.authorizationId !== authorizationId ||
    event.causationEventId === undefined
  ) {
    return { status: "NOT_AUTHORIZED", reasonCodes: ["AUTHORIZATION_NOT_FOUND"] }
  }

  const cause = await store.getByEventId(event.causationEventId)
  if (
    cause?.eventType !== "RISK_SHADOW_DECISION_RECORDED" ||
    cause.eventVersion !== "4.0.0" ||
    cause.cycleId !== event.cycleId
  ) {
    return { status: "NOT_AUTHORIZED", reasonCodes: ["AUTHORIZATION_INVALID"] }
  }
  const authorization = event.payload.instruction
  const expected = deriveExecutionAuthorizationV1({
    authorizationId,
    issuedAt: authorization.issuedAt,
    expiresAt: authorization.expiresAt,
    riskDecision: cause.payload.decision,
  })
  if (
    expected === undefined ||
    canonicalJson(expected) !== canonicalJson(authorization)
  ) {
    return { status: "NOT_AUTHORIZED", reasonCodes: ["AUTHORIZATION_INVALID"] }
  }

  const evaluatedAt = now.getTime()
  if (
    !Number.isFinite(evaluatedAt) ||
    evaluatedAt < Date.parse(authorization.issuedAt) ||
    evaluatedAt >= Date.parse(authorization.expiresAt)
  ) {
    return { status: "NOT_AUTHORIZED", reasonCodes: ["AUTHORIZATION_NOT_ACTIVE"] }
  }
  return { status: "AUTHORIZED", eventId: event.eventId, authorization }
}
