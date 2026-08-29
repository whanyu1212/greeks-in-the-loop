---
layout: home

hero:
  name: greeks-in-the-loop
  text: The agent proposes; deterministic code disposes
  tagline: A non-executing options research agent. An LLM proposes SPY debit spreads; pure, versioned application code validates, re-prices, and risk-gates them. No order-submission code exists anywhere in this repository.
  actions:
    - theme: brand
      text: Read the strategy
      link: /strategy-v1
    - theme: alt
      text: The deterministic gate
      link: /risk-engine-v1
    - theme: alt
      text: GitHub
      link: https://github.com/whanyu1212/greeks-in-the-loop

features:
  - title: The gate is a pure function
    details: evaluateTradeIntentRiskV1 takes one intent plus captured state and returns APPROVED/REJECTED. No I/O, no history, no ambient state. It is versioned, and anything that would make its output depend on database contents or past results is a design error.
  - title: Model output is never trusted for money
    details: Only the proposed spread's identity crosses from research into risk — direction, structure, expiration, two OCC leg symbols. Every financial input is re-fetched by the risk layer itself.
  - title: No floats in financial paths
    details: All money is integer cents. Exit marks are half-cents per share so the strategy's 50% thresholds stay exact rather than drifting through binary rounding.
  - title: Permissions, not prompts
    details: The research agent is deny-by-default. Bash, subagents, webfetch, and source edits are denied at the runtime boundary. Prompt instructions describe desired behavior but are not an authorization control.
---

## The central invariant

An LLM decides *what to propose*. It never decides *whether the trade passes*.

That separation is enforced structurally, not by asking the model nicely:

- **`evaluateTradeIntentRiskV1`** ([`src/risk/risk-evaluation-v1.ts`](https://github.com/whanyu1212/greeks-in-the-loop/blob/develop/src/risk/risk-evaluation-v1.ts)) is a pure function — no I/O, no history, no ambient state. Same inputs, same verdict, forever. It is versioned via `RISK_RULE_VERSION`.
- **Research's numbers are never trusted for the gate.** Only the spread's *identity* crosses the boundary. Equity, buying power, positions, live quotes, greeks, volume/open interest, and the market clock are all re-fetched by the risk layer from the broker.
- **Failures return bounded reason codes**, never raw model input — so a model cannot smuggle prose into an audit record.
- **All money is integer cents.** Exit marks are half-cents per share so 50% thresholds stay exact.

## Research to risk flow

```mermaid
flowchart TD
    S["Universe selection<br/>deterministic, no agent"]

    subgraph research["Research — probabilistic"]
        A["Research agent<br/>deny-by-default"]
        B["Confirm quotes<br/>deriveTradeIntentV1"]
        A -->|ProposedTradeDecisionV1| B
    end

    subgraph risk["Shadow risk — deterministic"]
        C["Re-fetch broker state<br/>research numbers discarded"]
        D["evaluateTradeIntentRiskV1<br/>pure, versioned gate"]
        C --> D
    end

    E["Append-only ledger<br/>NO ORDER SUBMITTED"]

    S -.->|not built| A
    B -->|TradeIntentV1<br/>identity only| C
    D -->|APPROVED / REJECTED| E

    F["Order construction"]
    G["Broker submit + fill tracking"]
    H["Position + exit management"]

    E -.->|not built| F
    F -.->|not built| G
    G -.->|not built| H
    H -.-> E

    classDef unbuilt stroke-dasharray:5 5,fill:transparent,color:#888,stroke:#888
    class S,F,G,H unbuilt
```

**Backtest replay** is a separate offline entry point (`pnpm backtest`), not a stage in this cycle:

```mermaid
flowchart LR
    R1["Immutable checksummed<br/>Alpaca dataset"]
    R2["EXACT_SNAPSHOT<br/>scenarios"]
    R3["HISTORICAL_BAR_PROXY<br/>scenarios"]
    RD["evaluateTradeIntentRiskV1<br/>same pure function"]
    R4["Exit mechanics only<br/>riskStatus: NOT_EVALUABLE"]
    R5["Report file<br/>never read by runtime code"]

    R1 --> R2 --> RD --> R5
    R1 --> R3 --> R4 --> R5
```

Solid edges are implemented today. Dotted nodes are deferred: universe selection upstream, and the execution path downstream where the shadow decision is recorded but never acted on.

## Where to start

| If you want to understand… | Read |
| --- | --- |
| What the agent is allowed to trade, and why it is frozen | [Strategy V1](/strategy-v1) |
| The gate rules, thresholds, and rejection codes | [Risk Engine V1](/risk-engine-v1) |
| How untrusted model output becomes a typed intent | [Research Decision V1](/research-decision-v1) |
| Spread economics and the integer-cent unit discipline | [Trade Intent V1](/trade-intent-v1) |
| How decisions are audited and made tamper-evident | [Event Ledger V1](/event-ledger-v1) |
| How rules are tested offline against real market data | [Backtest Replay V1](/backtest-replay-v1) |

## Why "shadow mode" is the point

The pipeline ends by recording a decision to an append-only event ledger. Nothing is submitted to a broker.

This is not an unfinished execution path — it is the deliverable. The interesting engineering problem in an LLM trading system is not order submission; it is building a boundary where a probabilistic component can propose without being able to act, and proving that boundary holds. The ledger records what *would* have happened, with the rule version that decided it, so a rule change can be attributed rather than guessed at.

Backtest replay feeds `EXACT_SNAPSHOT` scenarios into the **same** `evaluateTradeIntentRiskV1` the live path uses, with no agent in the loop. Its report file is never read back by runtime code — no backtest result can influence a live decision, by design.
