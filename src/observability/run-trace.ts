import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

/**
 * Append-only JSONL trace of one worker process, written for later reading.
 *
 * The durable record of what a cycle decided is the event ledger. This is a
 * different thing: how the cycle got there. Tool timings, the order calls were
 * made in, and the gaps between them live only in the OpenCode server's memory
 * and vanish when the process exits, which is exactly when a failed run most
 * needs explaining.
 *
 * One flat JSON object per line, keys short, `ms` relative to the cycle start
 * so a time gap is a subtraction rather than a date parse. Greppable without a
 * service and diffable between runs.
 *
 * Values are bounded on the way in. Tool inputs are model-authored and tool
 * outputs are provider payloads, so inputs are reduced to a truncated `k=v`
 * digest and outputs are never written at all.
 */

const MAX_VALUE_LENGTH = 200
const MAX_DIGEST_LENGTH = 400

const MAX_ARRAY_LENGTH = 16

export type RunTraceValue =
  | string
  | number
  | boolean
  | null
  | readonly (string | number)[]

export type RunTrace = Readonly<{
  append(kind: string, record: Readonly<Record<string, RunTraceValue>>): void
}>

export const NOOP_RUN_TRACE: RunTrace = { append: () => undefined }

/** Truncates one retained value to a bounded single-line string. */
export const boundedTraceValue = (value: RunTraceValue): RunTraceValue => {
  if (typeof value === "string") {
    return value.replace(/\s+/gu, " ").trim().slice(0, MAX_VALUE_LENGTH)
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((entry) =>
        typeof entry === "string"
          ? entry.replace(/\s+/gu, " ").trim().slice(0, MAX_VALUE_LENGTH)
          : entry
      )
  }
  return value
}

/**
 * Reduces a tool input object to a bounded `key=value` digest.
 *
 * The full object is model-authored and can be large; the diagnostic value is
 * almost always in the scalar arguments (a feed name, a limit, a symbol list),
 * so nested values collapse to their type rather than their content.
 */
export const traceInputDigest = (input: unknown): string => {
  if (input === null || typeof input !== "object") return ""
  return Object.entries(input as Record<string, unknown>)
    .map(([key, value]) =>
      `${key}=${
        value === null || typeof value !== "object"
          ? String(value)
          : Array.isArray(value)
            ? `[${value.length}]`
            : "{}"
      }`
    )
    .join(";")
    .slice(0, MAX_DIGEST_LENGTH)
}

export type CreateRunTraceOptions = Readonly<{
  path: string
  cycleId: string
  startedAtMs: number
  now?: () => number
  write?: (line: string) => void
}>

/** Opens one bounded JSONL trace sink for a single cycle. */
export function createRunTrace({
  path,
  cycleId,
  startedAtMs,
  now = () => Date.now(),
  write,
}: CreateRunTraceOptions): RunTrace {
  const append = write ?? ((line: string) => {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, line, "utf8")
  })
  return {
    append(kind, record) {
      const bounded: Record<string, RunTraceValue> = {}
      for (const [key, value] of Object.entries(record)) {
        bounded[key] = boundedTraceValue(value)
      }
      try {
        append(`${JSON.stringify({
          ms: Math.max(0, now() - startedAtMs),
          cycleId,
          kind,
          ...bounded,
        })}\n`)
      } catch {
        // A trace is a diagnostic; losing it must never fail a cycle.
      }
    },
  }
}
