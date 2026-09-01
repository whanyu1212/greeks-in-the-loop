# Research Report V5

`ResearchReportV5` wraps a V2 result with bounded agent-reported analysis:

- account checks;
- broad-market context separated from the candidate-specific regime;
- the application-authoritative option-universe snapshot;
- shortlisted-underlying returns, relative strength, ATR, EWMA and sample realized volatility, trend slope, range location, and volume/dollar-volume context;
- target-expiration volatility value, implied move, term structure, skew, curvature, quote coverage, feed class, and classified event risk;
- two-leg candidate diagnostics with retained long-minus-short spread Greeks;
- timestamped Exa and optional FMP context;
- supporting, contradicting, and unresolved factors.

Substantive research requires a thesis-relevant Exa source. A proposal additionally requires live candidate regime data, fresh account observations, broad-market context, 50 completed daily sessions, the complete three-underlying indicator set through the latest application-provided completed session, completed intraday bars, a usable option surface, classified event risk, and bounded candidate liquidity/Greeks. Runtime rejects a report that changes the supplied universe or selects outside it.

The indicator values are agent-reported research evidence, but proposal completeness and cross-field identities are deterministic. They help compare opportunities and explain conflicting signals; application code still owns schema validation, refreshed quotes, trade economics, and risk approval. Candidate diagnostics may retain IV-to-realized-volatility and bid-ask-spread ratios without retaining model-authored prices.

For candidate comparison, spread Greeks use position signs: net delta, gamma,
theta, and vega are each the long-leg value minus the short-leg value. The
agent compares theta cost, absolute vega exposure, and gamma per unit of
directional delta and records material tradeoffs in the factor arrays. Bullish
net delta must be 0.10–0.40; bearish net delta must be -0.40–-0.10. The
application independently repeats this calculation from fresh Alpaca
snapshots during shadow risk. Gamma, theta, and vega remain comparison metrics,
not hard limits.

All analysis verification is `AGENT_REPORTED`. Only application code may create independently verified quote evidence.

`NO_ACTION` is also evidence-bearing: it must retain at least one timestamped ALPACA, Exa, or FMP fact that states the decisive condition or measured value. These claims remain agent-reported; proposal evidence alone may reference an application-owned quote snapshot.

See `src/contracts/research-report-v5.ts`.
