# Research Report V3

`ResearchReportV3` wraps a V2 result with bounded agent-reported analysis:

- account checks;
- market regime;
- optional SPY/QQQ/IWM return, relative-strength, realized-volatility, and volume context;
- optional two-leg candidate diagnostics;
- timestamped Exa and optional FMP context;
- supporting, contradicting, and unresolved factors.

Substantive research requires a thesis-relevant Exa source. A proposal additionally requires live regime data, fresh account observations, 50 completed daily sessions, completed intraday bars, and bounded candidate liquidity/Greeks.

The extra indicators are advisory. They help the agent compare opportunities and explain conflicting signals; deterministic code still owns schema validation, refreshed quotes, trade economics, and risk approval. Candidate diagnostics may retain IV-to-realized-volatility and bid-ask-spread ratios without retaining model-authored prices.

All analysis verification is `AGENT_REPORTED`. Only application code may create independently verified quote evidence.

`NO_ACTION` is also evidence-bearing: it must retain at least one timestamped ALPACA, Exa, or FMP fact that states the decisive condition or measured value. These claims remain agent-reported; proposal evidence alone may reference an application-owned quote snapshot.

See `src/contracts/research-report-v3.ts`.
