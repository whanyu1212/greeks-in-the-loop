import { describe, expect, it } from "vitest"

import { runBacktestReplay } from "../src/backtest/replay.js"

const evaluatedAt = "2026-08-27T14:30:00.000Z"
const longSymbol = "SPY260918C00600000"
const shortSymbol = "SPY260918C00605000"
const quote = (
  contractSymbol: string,
  bidCentsPerShare: number,
  askCentsPerShare: number,
) => ({
  contractSymbol,
  feed: "INDICATIVE",
  bidCentsPerShare,
  askCentsPerShare,
  providerTimestamp: "2026-08-27T14:29:50.000000000Z",
})

describe("generic backtest replay", () => {
  it("retains V4 execution and exit assumptions in deterministic output", () => {
    const intent = {
      contractVersion: "4.0.0",
      decisionContractVersion: "4.0.0",
      underlying: "SPY",
      direction: "BULLISH",
      strategy: "BULL_CALL_SPREAD",
      quoteSnapshotRef: "quotes-SPY",
      evaluatedAt,
      legs: [
        {
          contractSymbol: longSymbol,
          positionIntent: "BUY_TO_OPEN",
          ratioQuantity: 1,
          quote: quote(longSymbol, 300, 310),
        },
        {
          contractSymbol: shortSymbol,
          positionIntent: "SELL_TO_OPEN",
          ratioQuantity: 1,
          quote: quote(shortSymbol, 100, 110),
        },
      ],
      premiumEffect: "DEBIT",
      entryLimitCentsPerStrategyUnit: 210,
    }
    const contractLeg = (
      contractSymbol: string,
      positionIntent: "BUY_TO_OPEN" | "SELL_TO_OPEN",
      delta: number,
    ) => ({
      contractSymbol,
      positionIntent,
      ratioQuantity: 1,
      active: true,
      tradable: true,
      exerciseStyle: "AMERICAN",
      multiplier: 100,
      delta,
      impliedVolatility: 0.25,
      gamma: 0.01,
      theta: -0.02,
      vega: 0.1,
      volume: 200,
      volumeDate: "2026-08-27",
      openInterest: 750,
      openInterestDate: "2026-08-26",
    })
    const output = runBacktestReplay({
      replayVersion: "8.0.0",
      initialEquityCents: 10_000_000,
      execution: {
        entrySlippageCentsPerLeg: 1,
        exitSlippageCentsPerLeg: 2,
        commissionCentsPerContract: 50,
      },
      exitPolicy: {
        stopLossBpsOfMaxLoss: 5_000,
        profitTargetBps: 3_000,
        minimumDte: 3,
        maxHoldingSessions: 5,
      },
      sessions: [{
        date: "2026-08-27",
        open: "2026-08-27T13:30:00.000Z",
        close: "2026-08-27T20:00:00.000Z",
      }],
      scenarios: [{
        scenarioId: "bull-call-profit",
        riskInput: {
          intent,
          context: {
            provenance: "APPLICATION_VERIFIED",
            eligibility: {
              evaluatedAt,
              sessionDate: "2026-08-27",
              researchEligible: true,
              tradeIntentEligible: true,
              tradeIntentWindow: {
                slotStartedAt: "2026-08-27T14:29:00.000Z",
                deadline: "2026-08-27T14:35:00.000Z",
              },
              previousSessionDates: ["2026-08-25", "2026-08-26"],
            },
            account: {
              snapshotVersion: "2.0.0",
              observedAt: evaluatedAt,
              status: "ACTIVE",
              tradingRestricted: false,
              optionsApprovedLevel: 3,
              optionsTradingLevel: 3,
              multilegOptionsApproved: true,
              buyingPowerCents: 20_000_000,
              cashCents: 20_000_000,
              equityCents: 10_000_000,
              lastEquityCents: 10_000_000,
            },
            candidateCollateral: {
              underlying: "SPY",
              longUnderlyingShares: 0,
              cashAvailableCents: 20_000_000,
              requiredLongSharesPerUnit: 0,
              requiredCashCentsPerUnit: 0,
              maxUnitsFromShares: null,
              maxUnitsFromCash: null,
            },
            portfolio: {
              observedAt: evaluatedAt,
              consistent: true,
              openStrategyPositionCount: 0,
              pendingEntryCount: 0,
              entriesSubmittedToday: 0,
              dailyBreakerActive: false,
              competitionBreakerActive: false,
            },
            contracts: {
              snapshotVersion: "2.0.0",
              slotStartedAt: "2026-08-27T14:29:00.000Z",
              observedAt: evaluatedAt,
              legs: [
                contractLeg(longSymbol, "BUY_TO_OPEN", 0.5),
                contractLeg(shortSymbol, "SELL_TO_OPEN", 0.3),
              ],
            },
          },
        },
        monitorCycles: [{
          decidedAt: "2026-08-27T14:31:00.000Z",
          marketOpen: true,
          lateFill: false,
          dte: 22,
          minutesToClose: 329,
          staleMinutes: 0,
          closePremiumCentsPerStrategyUnit: 300,
          holdingSessionIndex: 1,
        }],
      }],
    })

    expect(output).toMatchObject({
      replayVersion: "8.0.0",
      assumptions: {
        premiumMarks: "NATURAL_CLOSE_COST_CENTS_PER_STRATEGY_UNIT",
        contractMultiplier: 100,
      },
      scenarios: [{
        scenarioId: "bull-call-profit",
        risk: { outcome: "APPROVED", ruleVersion: "2.0.0" },
        simulation: {
          outcome: "CLOSED",
          exitReason: "PROFIT_TARGET",
          pnlCents: 8_200,
        },
      }],
      aggregate: { status: "COMPLETE", totalPnlCents: 8_200 },
    })
  })
})
