---
layout: home

hero:
  name: greeks-in-the-loop
  text: Agent research, deterministic risk
  tagline: One agent researches a bounded dynamic option universe; application code validates and risk-gates it.
  actions:
    - theme: brand
      text: Risk engine
      link: /risk-engine-v1
    - theme: alt
      text: Dry runs
      link: /dry-run-research
---

Application code discovers three active, optionable, high-activity underlyings. The research agent compares that exact snapshot, then returns no action or one directional debit-spread proposal. It has no execution authority.

```text
OptionUniverseSnapshotV1 -> ResearchReportV5 -> ResearchDecisionV2 -> TradeIntentV2
                 -> application-owned state -> pure risk gate -> ledger
```

Start with:

- [Dry-run research](/dry-run-research)
- [Research source policy](/research-source-policy)
- [Research Decision V2](/research-decision-v2)
- [Research Report V5](/research-report-v5)
- [Trade Intent V2](/trade-intent-v2)
- [Risk Engine V1](/risk-engine-v1)
- [Event Ledger V3](/event-ledger-v1)
- [Deterministic replay](/backtest-replay-v1)
