---
layout: home

hero:
  name: greeks-in-the-loop
  text: Agent research, deterministic risk
  tagline: One agent selects and researches a bounded ETF opportunity; application code validates and risk-gates it.
  actions:
    - theme: brand
      text: Risk engine
      link: /risk-engine-v1
    - theme: alt
      text: Dry runs
      link: /dry-run-research
---

The research agent compares `SPY`, `QQQ`, and `IWM`, then returns no action, preliminary research, or one directional debit-spread proposal. It has no execution authority.

```text
ResearchReportV3 -> ResearchDecisionV2 -> TradeIntentV2
                 -> application-owned state -> pure risk gate -> ledger
```

Start with:

- [Dry-run research](/dry-run-research)
- [Research source policy](/research-source-policy)
- [Research Decision V2](/research-decision-v2)
- [Research Report V3](/research-report-v3)
- [Trade Intent V2](/trade-intent-v2)
- [Risk Engine V1](/risk-engine-v1)
- [Event Ledger V1](/event-ledger-v1)
- [Deterministic replay](/backtest-replay-v1)
