import type { OpencodeClient, Part } from "@opencode-ai/sdk"
import { z } from "zod"

import { assertResearchModelIdentityV1 } from "../research/invocation.js"
import type { ExecutionAuthorizationV1 } from "./authorization-v1.js"
import {
  PAPER_TRADER_RESULT_VERSION,
  paperTraderResultV1Schema,
  type PaperTraderResultV1,
} from "./paper-trader-result-v1.js"

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
export const buildPaperTraderPrompt = (authorizationId: string) =>
  `Process execution authorization ID ${JSON.stringify(identifier.parse(authorizationId))}. Resolve it through the execution authorization tool, follow the checked-in trader policy exactly, and return only the required bare JSON result.`

const textResponse = (parts: readonly Part[]) =>
  parts
    .flatMap((part) =>
      part.type === "text" && typeof part.text === "string"
        ? [part.text.trim()]
        : [],
    )
    .filter(Boolean)
    .join("\n")

const syntheticResult = (
  authorization: ExecutionAuthorizationV1,
  status: "NOT_SUBMITTED" | "SUBMISSION_UNKNOWN",
  reason: string,
  now: () => Date,
): PaperTraderResultV1 => ({
  resultVersion: PAPER_TRADER_RESULT_VERSION,
  status,
  authorizationId: authorization.authorizationId,
  clientOrderId: authorization.order.client_order_id,
  observedAt: now().toISOString(),
  reasonCodes: [reason],
})

export type InvokePaperTraderOptions = Readonly<{
  client: OpencodeClient
  authorization: ExecutionAuthorizationV1
  signal: AbortSignal
  now?: () => Date
}>

/** Runs the trader in a separate session whose prompt contains only the lookup ID. */
export async function invokePaperTrader({
  client,
  authorization,
  signal,
  now = () => new Date(),
}: InvokePaperTraderOptions): Promise<PaperTraderResultV1> {
  signal.throwIfAborted()
  const created = await client.session.create({
    body: { title: `paper-trader ${authorization.authorizationId}` },
    signal,
  }).catch(() => undefined)
  const sessionId = created?.data?.id
  if (sessionId === undefined) {
    return syntheticResult(
      authorization,
      "NOT_SUBMITTED",
      "TRADER_SESSION_FAILED",
      now,
    )
  }

  try {
    const response = await client.session.prompt({
      path: { id: sessionId },
      signal,
      body: {
        agent: "trader",
        parts: [{
          type: "text",
          text: buildPaperTraderPrompt(authorization.authorizationId),
        }],
      },
    }).catch(() => undefined)
    if (!response?.data) {
      return syntheticResult(
        authorization,
        "SUBMISSION_UNKNOWN",
        "TRADER_PROMPT_FAILED",
        now,
      )
    }

    const identity = assertResearchModelIdentityV1({
      providerId: response.data.info.providerID,
      modelId: response.data.info.modelID,
    })
    if (!identity.ok) {
      return syntheticResult(
        authorization,
        "SUBMISSION_UNKNOWN",
        "TRADER_MODEL_DRIFT",
        now,
      )
    }

    let input: unknown
    try {
      const text = textResponse(response.data.parts)
      if (Buffer.byteLength(text, "utf8") > 16 * 1024) throw new Error()
      input = JSON.parse(text)
    } catch {
      return syntheticResult(
        authorization,
        "SUBMISSION_UNKNOWN",
        "TRADER_RESPONSE_INVALID",
        now,
      )
    }
    const parsed = paperTraderResultV1Schema.safeParse(input)
    if (
      !parsed.success ||
      parsed.data.authorizationId !== authorization.authorizationId ||
      (parsed.data.clientOrderId !== null &&
        parsed.data.clientOrderId !== authorization.order.client_order_id)
    ) {
      return syntheticResult(
        authorization,
        "SUBMISSION_UNKNOWN",
        "TRADER_RESPONSE_INVALID",
        now,
      )
    }
    return parsed.data
  } finally {
    await client.session.delete({ path: { id: sessionId } }).catch(() => undefined)
  }
}
