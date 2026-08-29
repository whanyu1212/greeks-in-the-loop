import { describe, expect, it } from "vitest"

import {
  alpacaOptionStrikeCents,
  alpacaOptionSymbolSchema,
  parseAlpacaOptionSymbol,
  spyAlpacaOptionSymbolV1Schema,
  validateSpyOptionUniverseV1,
} from "../src/shared/alpaca-option-identity.js"

const parseIdentity = (symbol: string) => {
  const result = parseAlpacaOptionSymbol(symbol)
  if (!result.success) throw new Error(`Expected ${symbol} to parse`)
  return result.identity
}

describe("parseAlpacaOptionSymbol", () => {
  it("parses an exact compact SPY identity without normalizing it", () => {
    expect(parseAlpacaOptionSymbol("SPY260918C00650000")).toEqual({
      success: true,
      identity: {
        provider: "ALPACA",
        brokerSymbol: "SPY260918C00650000",
        root: "SPY",
        expiration: "2026-09-18",
        optionType: "C",
        strikeThousandthsPerShare: 650_000,
      },
    })
  })

  it("parses a valid non-SPY identity before universe authorization", () => {
    const parsed = parseAlpacaOptionSymbol("QQQ260918P00650000")

    expect(parsed).toEqual({
      success: true,
      identity: {
        provider: "ALPACA",
        brokerSymbol: "QQQ260918P00650000",
        root: "QQQ",
        expiration: "2026-09-18",
        optionType: "P",
        strikeThousandthsPerShare: 650_000,
      },
    })
    if (!parsed.success) throw new Error("Expected QQQ identity to parse")
    expect(validateSpyOptionUniverseV1(parsed.identity)).toEqual({
      success: false,
      reason: "UNDERLYING_NOT_SUPPORTED",
    })
  })

  it.each([
    ["one-character", "A260918C00001000", "A"],
    ["six-character", "ABC123260918P00001000", "ABC123"],
  ])("accepts a %s root", (_description, symbol, root) => {
    const parsed = parseAlpacaOptionSymbol(symbol)
    expect(parsed.success).toBe(true)
    if (!parsed.success) throw new Error("Expected identity to parse")
    expect(parsed.identity.root).toBe(root)
  })

  it.each([
    "spy260918C00650000",
    "SP_Y260918C00650000",
    "ABCDEFG260918C00650000",
    "  SPY260918C00650000",
    "SPY   260918C00650000",
    "260918C00650000",
    "SPY260918X00650000",
    "SPY260918C0065000",
    "SPY260918C006500000",
    "SPY260918C00650A00",
  ])("rejects malformed compact syntax: %s", (symbol) => {
    expect(parseAlpacaOptionSymbol(symbol)).toEqual({
      success: false,
      reason: "SYMBOL_FORMAT_INVALID",
    })
  })

  it.each([
    "SPY260018C00650000",
    "SPY261318C00650000",
    "SPY260900C00650000",
    "SPY260431C00650000",
    "SPY250229C00650000",
  ])("rejects an impossible expiration date: %s", (symbol) => {
    expect(parseAlpacaOptionSymbol(symbol)).toEqual({
      success: false,
      reason: "EXPIRATION_DATE_INVALID",
    })
  })

  it("accepts a valid leap-day expiration", () => {
    expect(parseAlpacaOptionSymbol("SPY240229C00650000").success).toBe(true)
  })
})

describe("Alpaca option identity policies", () => {
  it("admits SPY through the V1 universe policy", () => {
    expect(
      validateSpyOptionUniverseV1(
        parseIdentity("SPY260918C00650000"),
      ),
    ).toEqual({ success: true })
  })

  it("projects exact thousandths into integer cents", () => {
    expect(
      alpacaOptionStrikeCents(parseIdentity("SPY260918C00650000")),
    ).toEqual({
      success: true,
      strikeCentsPerShare: 65_000,
    })
  })

  it("keeps sub-cent precision valid syntax but rejects its cent projection", () => {
    const identity = parseIdentity("SPY260918C00650001")

    expect(identity.strikeThousandthsPerShare).toBe(650_001)
    expect(alpacaOptionStrikeCents(identity)).toEqual({
      success: false,
      reason: "STRIKE_PRECISION_UNSUPPORTED",
    })
  })

  it("keeps syntax-only and SPY-authorized schemas distinct", () => {
    expect(alpacaOptionSymbolSchema.safeParse("QQQ260918C00650000").success).toBe(
      true,
    )
    expect(
      spyAlpacaOptionSymbolV1Schema.safeParse("QQQ260918C00650000").success,
    ).toBe(false)
    expect(
      spyAlpacaOptionSymbolV1Schema.safeParse("SPY260918C00650000").success,
    ).toBe(true)
  })

  it("makes both schemas fail closed on impossible dates", () => {
    expect(
      alpacaOptionSymbolSchema.safeParse("SPY260431C00650000").success,
    ).toBe(false)
    expect(
      spyAlpacaOptionSymbolV1Schema.safeParse("SPY260431C00650000").success,
    ).toBe(false)
  })
})
