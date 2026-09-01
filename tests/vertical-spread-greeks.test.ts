import { describe, expect, it } from "vitest"

import { deriveVerticalSpreadGreeksV1 } from "../src/shared/vertical-spread-greeks.js"

describe("deriveVerticalSpreadGreeksV1", () => {
  it("applies long-minus-short position signs to every Greek", () => {
    expect(
      deriveVerticalSpreadGreeksV1(
        { delta: 0.55, gamma: 0.02, theta: -0.1, vega: 0.15 },
        { delta: 0.3, gamma: 0.015, theta: -0.08, vega: 0.12 },
      ),
    ).toEqual({
      calculation: "LONG_MINUS_SHORT",
      netDelta: 0.25,
      netGamma: 0.005,
      netTheta: -0.02,
      netVega: 0.03,
    })
  })

  it("preserves bearish put-spread direction", () => {
    expect(
      deriveVerticalSpreadGreeksV1(
        { delta: -0.55, gamma: 0.02, theta: -0.1, vega: 0.15 },
        { delta: -0.3, gamma: 0.015, theta: -0.08, vega: 0.12 },
      )?.netDelta,
    ).toBe(-0.25)
  })

  it("fails closed when subtraction overflows", () => {
    expect(
      deriveVerticalSpreadGreeksV1(
        { delta: Number.MAX_VALUE, gamma: 0, theta: 0, vega: 0 },
        { delta: -Number.MAX_VALUE, gamma: 0, theta: 0, vega: 0 },
      ),
    ).toBeUndefined()
  })
})
