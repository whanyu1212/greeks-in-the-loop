import { describe, expect, it, vi } from "vitest"

import type { TradeIntentV4 } from "../src/contracts/trade-intent-v4.js"
import { createAlpacaOrderSubmitter } from "../src/execution/alpaca-order-submitter.js"

const TIMESTAMP = "2026-08-26T10:00:00.000Z"
const intent: TradeIntentV4 = {
  contractVersion: "4.0.0",
  decisionContractVersion: "4.0.0",
  underlying: "SPY",
  direction: "BULLISH",
  strategy: "BULL_CALL_SPREAD",
  quoteSnapshotRef: "snapshot-1",
  evaluatedAt: TIMESTAMP,
  legs: [
    {
      contractSymbol: "SPY260918C00650000",
      positionIntent: "BUY_TO_OPEN",
      ratioQuantity: 1,
      quote: {
        contractSymbol: "SPY260918C00650000",
        feed: "INDICATIVE",
        bidCentsPerShare: 220,
        askCentsPerShare: 223,
        providerTimestamp: "2026-08-26T09:59:30.000000000Z",
      },
    },
    {
      contractSymbol: "SPY260918C00655000",
      positionIntent: "SELL_TO_OPEN",
      ratioQuantity: 1,
      quote: {
        contractSymbol: "SPY260918C00655000",
        feed: "INDICATIVE",
        bidCentsPerShare: 120,
        askCentsPerShare: 121,
        providerTimestamp: "2026-08-26T09:59:31.000000000Z",
      },
    },
  ],
  premiumEffect: "DEBIT",
  entryLimitCentsPerStrategyUnit: 103,
}

const submitterWith = (fetchMock: typeof fetch) =>
  createAlpacaOrderSubmitter({
    apiKey: "key",
    secretKey: "secret",
    fetch: fetchMock,
  })

describe("createAlpacaOrderSubmitter", () => {
  it("distinguishes confirmed absence from lookup uncertainty", async () => {
    const notFound = submitterWith(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })),
    )
    const unavailable = submitterWith(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
    )
    const malformed = submitterWith(
      vi.fn<typeof fetch>().mockResolvedValue(new Response("{", { status: 200 })),
    )
    const signal = AbortSignal.timeout(5_000)

    await expect(notFound.lookup({ clientOrderId: "cycle-1", signal })).resolves
      .toEqual({ status: "CONFIRMED_NOT_FOUND" })
    await expect(unavailable.lookup({ clientOrderId: "cycle-1", signal })).resolves
      .toEqual({ status: "LOOKUP_UNKNOWN", reason: "BROKER_REQUEST_FAILED" })
    await expect(malformed.lookup({ clientOrderId: "cycle-1", signal })).resolves
      .toEqual({ status: "LOOKUP_UNKNOWN", reason: "BROKER_RESPONSE_INVALID" })
  })

  it("keeps pending_cancel open", async () => {
    const submitter = submitterWith(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "broker-1",
            client_order_id: "cycle-1",
            status: "pending_cancel",
          }),
          { status: 200 },
        ),
      ),
    )

    await expect(
      submitter.lookup({
        clientOrderId: "cycle-1",
        signal: AbortSignal.timeout(5_000),
      }),
    ).resolves.toEqual({
      status: "FOUND",
      order: {
        status: "OPEN",
        brokerOrderId: "broker-1",
        brokerStatus: "pending_cancel",
      },
    })
  })

  it("does not reject or retry an ambiguous submission followed by a 404", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
    const submitter = submitterWith(fetchMock)

    await expect(
      submitter.submit({
        intent,
        clientOrderId: "cycle-1",
        signal: AbortSignal.timeout(5_000),
      }),
    ).resolves.toEqual({
      status: "UNKNOWN",
      reason: "BROKER_REQUEST_FAILED",
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "POST",
      "GET",
    ])
  })
})
