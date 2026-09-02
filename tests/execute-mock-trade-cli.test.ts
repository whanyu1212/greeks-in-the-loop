import { describe, expect, it } from "vitest"

import { resolveMockLedgerConfiguration } from "../src/execution/execute-mock-trade-cli.js"

describe("resolveMockLedgerConfiguration", () => {
  it("selects the dedicated SQLite backend in a PostgreSQL deployment", () => {
    const previousBackend = process.env.RESEARCH_LEDGER_BACKEND
    process.env.RESEARCH_LEDGER_BACKEND = "postgres"
    try {
      expect(resolveMockLedgerConfiguration(".state/mock-execution.sqlite")).toEqual({
        backend: "sqlite",
        path: ".state/mock-execution.sqlite",
      })
    } finally {
      if (previousBackend === undefined) delete process.env.RESEARCH_LEDGER_BACKEND
      else process.env.RESEARCH_LEDGER_BACKEND = previousBackend
    }
  })

  it("rejects canonical aliases of the production ledger", () => {
    expect(() =>
      resolveMockLedgerConfiguration(".state/nested/../research-ledger.sqlite"),
    ).toThrow("Mock execution cannot use the production research ledger")
  })
})
