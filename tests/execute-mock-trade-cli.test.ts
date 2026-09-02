import { describe, expect, it } from "vitest"

import {
  resolveMockLedgerConfiguration,
  syntheticOpeningDelta,
} from "../src/execution/execute-mock-trade-cli.js"

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

describe("syntheticOpeningDelta", () => {
  it("produces directional net deltas for call and put debit spreads", () => {
    const callNetDelta =
      syntheticOpeningDelta("SPY260918C00650000", "BUY_TO_OPEN") -
      syntheticOpeningDelta("SPY260918C00655000", "SELL_TO_OPEN")
    const putNetDelta =
      syntheticOpeningDelta("SPY260918P00650000", "BUY_TO_OPEN") -
      syntheticOpeningDelta("SPY260918P00645000", "SELL_TO_OPEN")

    expect(callNetDelta).toBeCloseTo(0.24)
    expect(putNetDelta).toBeCloseTo(-0.24)
  })
})
