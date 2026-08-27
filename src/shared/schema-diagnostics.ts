import type { ZodIssue } from "zod"

export const SCHEMA_VIOLATION_CATEGORIES = [
  "REQUIRED_FIELD_MISSING",
  "TYPE_MISMATCH",
  "VALUE_NOT_ALLOWED",
  "FORMAT_INVALID",
  "OUT_OF_RANGE",
  "UNRECOGNIZED_FIELD",
  "RELATIONSHIP_INVALID",
  "OTHER_SCHEMA_VIOLATION",
] as const

export type SchemaViolationCategory =
  (typeof SCHEMA_VIOLATION_CATEGORIES)[number]

export type SafeSchemaDiagnostic = Readonly<{
  code: "SCHEMA_INVALID"
  schemaCategory: SchemaViolationCategory
  path: readonly (string | number)[]
}>

const safePath = (path: readonly PropertyKey[]) =>
  path.slice(0, 32).map((part) =>
    typeof part === "number"
      ? Math.max(0, part)
      : String(part).slice(0, 128),
  )

export const schemaViolationCategory = (
  issue: ZodIssue,
  input?: unknown,
): SchemaViolationCategory => {
  switch (issue.code) {
    case "invalid_type":
      return issue.path.reduce<unknown>((value, part) => {
        if (typeof value !== "object" || value === null) return value
        return Reflect.get(value, part)
      }, input) === undefined
        ? "REQUIRED_FIELD_MISSING"
        : "TYPE_MISMATCH"
    case "invalid_value":
    case "invalid_union":
      return "VALUE_NOT_ALLOWED"
    case "invalid_format":
      return "FORMAT_INVALID"
    case "too_big":
    case "too_small":
    case "not_multiple_of":
      return "OUT_OF_RANGE"
    case "unrecognized_keys":
      return "UNRECOGNIZED_FIELD"
    case "custom":
      return "RELATIONSHIP_INVALID"
    default:
      return "OTHER_SCHEMA_VIOLATION"
  }
}

/** Removes messages, rejected values, and schema internals from Zod failures. */
export const safeSchemaDiagnostics = (
  issues: readonly ZodIssue[],
  input?: unknown,
): SafeSchemaDiagnostic[] =>
  issues.map((issue) => ({
    code: "SCHEMA_INVALID",
    schemaCategory: schemaViolationCategory(issue, input),
    path: safePath(issue.path),
  }))
