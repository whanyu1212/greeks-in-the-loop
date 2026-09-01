import { z } from "zod"

export const PAPER_TRADER_RESULT_VERSION = "1.0.0" as const
const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const reasonCode = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/u)
const common = {
  resultVersion: z.literal(PAPER_TRADER_RESULT_VERSION),
  authorizationId: identifier,
  observedAt: timestamp,
} as const

export const paperTraderResultV1Schema = z.discriminatedUnion("status", [
  z
    .object({
      ...common,
      status: z.literal("SUBMITTED"),
      clientOrderId: identifier,
      paperOrderId: identifier,
      brokerStatus: identifier,
      reasonCodes: z.array(reasonCode).length(0),
    })
    .strict(),
  z
    .object({
      ...common,
      status: z.enum(["NOT_SUBMITTED", "SUBMISSION_UNKNOWN"]),
      clientOrderId: identifier.nullable(),
      paperOrderId: identifier.optional(),
      brokerStatus: identifier.optional(),
      reasonCodes: z.array(reasonCode).min(1).max(16),
    })
    .strict(),
])

export type PaperTraderResultV1 = Readonly<
  z.infer<typeof paperTraderResultV1Schema>
>
