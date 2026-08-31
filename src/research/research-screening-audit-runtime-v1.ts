import {
  createApplicationCaptureUnavailableAuditV1,
  createApplicationResearchScreeningAuditV1,
  createApplicationScreeningUnavailableAuditV1,
  type ApplicationResearchScreeningAuditV1,
} from "../contracts/research-screening-audit-v1.js"
import { validateResearchSnapshotPairV1 } from "../contracts/research-market-snapshot-builders-v1.js"
import type { ResearchSnapshotProviderV1 } from "../market-data/alpaca-research-snapshot-provider-v1.js"
import {
  screenSpyDirectionalDebitVerticalWithAuditV1,
  type SpyDebitVerticalAuditedScreeningResultV1,
  type ValidatedResearchSnapshotPairV1,
} from "../strategy/directional-debit-vertical-v1.js"

export type RunApplicationResearchScreeningAuditV1Options = Readonly<{
  provider: ResearchSnapshotProviderV1
  sessionDate: string
  slotStartedAt: string
  signal: AbortSignal
  nowMs?: () => number
  screen?: (
    pair: ValidatedResearchSnapshotPairV1,
  ) => SpyDebitVerticalAuditedScreeningResultV1
}>

const boundedClock = (nowMs: () => number) => () => {
  try {
    const value = nowMs()
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

const elapsedMs = (startedAt: number, nowMs: () => number) => {
  const elapsed = Math.round(nowMs() - startedAt)
  return Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : 0
}

const cancellationReason = (signal: AbortSignal) =>
  signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? "AUDIT_DEADLINE_EXCEEDED" as const
    : "AUDIT_CANCELLED" as const

/** Captures and screens one audit-only SPY snapshot without exposing it to runtime authority. */
export async function runApplicationResearchScreeningAuditV1({
  provider,
  sessionDate,
  slotStartedAt,
  signal,
  nowMs = () => performance.now(),
  screen = screenSpyDirectionalDebitVerticalWithAuditV1,
}: RunApplicationResearchScreeningAuditV1Options): Promise<ApplicationResearchScreeningAuditV1> {
  const clock = boundedClock(nowMs)
  const captureStartedAt = clock()
  let captured: Awaited<ReturnType<ResearchSnapshotProviderV1["capture"]>>
  try {
    captured = await provider.capture({ sessionDate, slotStartedAt, signal })
  } catch {
    return createApplicationCaptureUnavailableAuditV1(
      [signal.aborted ? cancellationReason(signal) : "UNEXPECTED_FAILURE"],
      elapsedMs(captureStartedAt, clock),
    )
  }

  const captureDurationMs = elapsedMs(captureStartedAt, clock)
  if (!captured.success) {
    return createApplicationCaptureUnavailableAuditV1(
      captured.reasons.length === 0
        ? ["UNEXPECTED_FAILURE"]
        : captured.reasons,
      captureDurationMs,
    )
  }

  const pair = validateResearchSnapshotPairV1(
    captured.underlying,
    captured.optionUniverse,
  )
  if (!pair.success) {
    return createApplicationCaptureUnavailableAuditV1(
      [pair.reason],
      captureDurationMs,
    )
  }

  const screeningStartedAt = clock()
  try {
    return createApplicationResearchScreeningAuditV1({
      pair,
      audited: screen(pair),
      captureDurationMs,
      screeningDurationMs: elapsedMs(screeningStartedAt, clock),
    })
  } catch {
    return createApplicationScreeningUnavailableAuditV1({
      pair,
      captureDurationMs,
      screeningDurationMs: elapsedMs(screeningStartedAt, clock),
      reason: "UNEXPECTED_FAILURE",
    })
  }
}
