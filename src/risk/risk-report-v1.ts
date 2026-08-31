import type { StoredLedgerEvent } from "../event-ledger/ledger-event-v1.js"

export const RISK_REPORT_VERSION = "1.0.0" as const

export function buildRiskReportV1(
  events: readonly StoredLedgerEvent[],
  tradingDate?: string,
) {
  const cycleDates = new Map<string, string>()
  for (const event of events) {
    if (
      event.eventType === "RESEARCH_CYCLE_STARTED" &&
      event.cycleId !== undefined &&
      event.payload.sessionDate !== undefined
    ) {
      cycleDates.set(event.cycleId, event.payload.sessionDate)
    }
  }

  const reasonCounts = new Map<string, number>()
  let approvedCount = 0
  let ruleRejectedCount = 0
  let captureRejectedCount = 0
  let intentRefreshRejectedCount = 0
  const decisions = events.flatMap((event) => {
    if (event.eventType !== "RISK_SHADOW_DECISION_RECORDED") return []
    const eventTradingDate = event.cycleId === undefined
      ? undefined
      : cycleDates.get(event.cycleId)
    if (tradingDate !== undefined && eventTradingDate !== tradingDate) return []
    const decision = event.payload.decision
    const reasonCodes = decision.stage === "STATE_CAPTURE_FAILED"
      ? decision.captureReasonCodes
      : decision.stage === "INTENT_REFRESH_FAILED"
        ? decision.derivationReasonCodes
        : decision.evaluation.outcome === "REJECTED"
          ? decision.evaluation.reasonCodes
          : []
    for (const reason of reasonCodes) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1)
    }
    if (decision.stage === "STATE_CAPTURE_FAILED") captureRejectedCount += 1
    else if (decision.stage === "INTENT_REFRESH_FAILED") {
      intentRefreshRejectedCount += 1
    } else if (decision.outcome === "APPROVED") approvedCount += 1
    else ruleRejectedCount += 1

    return [{
      sequence: event.sequence,
      eventId: event.eventId,
      cycleId: event.cycleId,
      causationEventId: event.causationEventId,
      tradingDate: eventTradingDate,
      recordedAt: event.recordedAt,
      stage: decision.stage,
      outcome: decision.outcome,
      evaluatedAt: decision.stage === "EVALUATED"
        ? decision.evaluation.evaluatedAt
        : decision.evaluatedAt,
      reasonCodes,
    }]
  })
  const breakerLatches = events.filter((event) => {
    if (event.eventType !== "RISK_BREAKER_LATCHED") return false
    return tradingDate === undefined || event.payload.tradingDate === tradingDate
  })

  return {
    reportVersion: RISK_REPORT_VERSION,
    tradingDate: tradingDate ?? null,
    decisionCount: decisions.length,
    approvedCount,
    ruleRejectedCount,
    captureRejectedCount,
    intentRefreshRejectedCount,
    breakerLatchCount: breakerLatches.length,
    reasonCounts: Object.fromEntries(
      [...reasonCounts.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    decisions,
  }
}
