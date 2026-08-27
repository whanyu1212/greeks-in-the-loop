import { describe, expect, it } from "vitest"
import { z, type ZodIssue } from "zod"

import {
  safeSchemaDiagnostics,
  schemaViolationCategory,
} from "../src/shared/schema-diagnostics.js"

const firstIssue = (schema: z.ZodType, input: unknown) => {
  const result = schema.safeParse(input)
  if (result.success) throw new Error("Expected schema validation to fail")
  return result.error.issues[0]!
}

describe("safe schema diagnostics", () => {
  it.each([
    [z.object({ value: z.string() }), {}, "REQUIRED_FIELD_MISSING"],
    [z.object({ value: z.enum(["A", "B"]) }), {}, "REQUIRED_FIELD_MISSING"],
    [z.object({ value: z.literal("A") }), {}, "REQUIRED_FIELD_MISSING"],
    [z.string(), 1, "TYPE_MISMATCH"],
    [z.enum(["A", "B"]), "C", "VALUE_NOT_ALLOWED"],
    [z.email(), "not-an-email", "FORMAT_INVALID"],
    [z.number().min(2), 1, "OUT_OF_RANGE"],
    [z.object({}).strict(), { secret: true }, "UNRECOGNIZED_FIELD"],
    [z.string().refine(() => false), "secret", "RELATIONSHIP_INVALID"],
  ] as const)("maps a failure to a safe category", (schema, input, category) => {
    expect(schemaViolationCategory(firstIssue(schema, input), input)).toBe(category)
  })

  it("uses a safe fallback without messages or rejected input", () => {
    const diagnostic = safeSchemaDiagnostics([
      {
        code: "invalid_key",
        path: ["field"],
        message: "secret-message",
        input: "secret-input",
      } as unknown as ZodIssue,
    ])[0]!

    expect(diagnostic).toEqual({
      code: "SCHEMA_INVALID",
      schemaCategory: "OTHER_SCHEMA_VIOLATION",
      path: ["field"],
    })
    expect(JSON.stringify(diagnostic)).not.toContain("secret")
  })
})
