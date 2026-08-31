# Trade Intent V2

`TradeIntentV2` is derived by application code from a validated proposal and freshly confirmed exact-leg quotes.

It retains candidate identity, confirmed quotes, integer-cent spread economics, and half-cent exit marks. Its redundant fields are cross-checked against OCC identity and recalculated from exact inputs.

The agent cannot author this contract. `deriveTradeIntentV2` fails closed on symbol mismatch, stale or future quotes, unsupported precision, invalid debit, or arithmetic overflow.

See `src/contracts/trade-intent-v2.ts` for the authoritative schema.
