import {
  buildOptionUniverseSnapshotV1,
  buildUnderlyingSessionSnapshotV1,
  validateResearchSnapshotPairV1,
  type OptionUniverseSnapshotBuildInputV1,
} from "../../src/contracts/research-market-snapshot-builders-v1.js"
import {
  computeOptionUniverseSnapshotIdV1,
  computeUnderlyingSessionSnapshotIdV1,
} from "../../src/contracts/research-market-snapshot-v1.js"
import {
  researchReportV2Schema,
  type ResearchReportV2,
} from "../../src/contracts/research-report-v2.js"
import {
  createAgentResearchScreeningModelDriftAuditV1,
  createAgentResearchScreeningUnavailableAuditV1,
  createApplicationCaptureUnavailableAuditV1,
  createApplicationResearchScreeningAuditV1,
  createApplicationScreeningUnavailableAuditV1,
  createResearchScreeningAuditInputIdentityV1,
  createResearchScreeningAuditV1,
  projectResearchReportV2ForScreeningAudit,
  type AgentResearchScreeningAuditV1,
  type ApplicationResearchScreeningAuditV1,
  type IdenticalInputParityChecksV1,
  type ResearchScreeningAuditInputIdentityV1,
  type ResearchScreeningAuditV1,
} from "../../src/contracts/research-screening-audit-v1.js"
import {
  ledgerEventV1Schema,
  type LedgerEventV1,
  type StoredLedgerEventV1,
} from "../../src/event-ledger/ledger-event-v1.js"
import type { ResearchInvocationV1 } from "../../src/research/research-invocation-v1.js"
import {
  screenSpyDirectionalDebitVerticalWithAuditV1,
  type ValidatedResearchSnapshotPairV1,
} from "../../src/strategy/directional-debit-vertical-v1.js"
import {
  createOptionUniverseSnapshotInputV1,
  createUnderlyingSnapshotInputV1,
} from "./research-market-snapshot-v1.js"

type ContractInput = OptionUniverseSnapshotBuildInputV1["contracts"][number]

const optionSymbol = (
  expirationDate: string,
  optionType: "CALL" | "PUT",
  strikeCentsPerShare: number,
) =>
  `SPY${expirationDate.slice(2).replaceAll("-", "")}${
    optionType === "CALL" ? "C" : "P"
  }${String(strikeCentsPerShare * 10).padStart(8, "0")}`

export const createAuditContractV1 = (overrides: Partial<ContractInput> &
  Pick<ContractInput, "strikeCentsPerShare">): ContractInput => {
  const { strikeCentsPerShare, ...rest } = overrides
  const expirationDate = rest.expirationDate ?? "2026-09-18"
  const optionType = rest.optionType ?? "CALL"
  const contractSymbol = rest.contractSymbol ?? optionSymbol(
    expirationDate,
    optionType,
    strikeCentsPerShare,
  )
  return {
    contractSymbol,
    expirationDate,
    optionType,
    strikeCentsPerShare,
    active: true,
    tradable: true,
    exerciseStyle: "AMERICAN",
    multiplier: 100,
    quote: {
      providerTimestamp: "2026-08-28T14:00:45.000Z",
      bidCentsPerShare: 400,
      askCentsPerShare: 410,
    },
    greeks: {
      deltaMillionths: 500_000,
      gammaMillionths: 20_000,
      thetaMillionths: -100_000,
      vegaMillionths: 150_000,
      impliedVolatilityMillionths: 200_000,
    },
    currentSessionVolume: {
      sessionDate: "2026-08-28",
      providerTimestamp: "2026-08-28T14:00:00.000Z",
      contracts: 100,
    },
    openInterest: { asOfDate: "2026-08-27", contracts: 500 },
    ...rest,
  }
}

export const createEligibleAuditContractsV1 = () => [
  createAuditContractV1({ strikeCentsPerShare: 63_000 }),
  createAuditContractV1({
    strikeCentsPerShare: 63_500,
    quote: {
      providerTimestamp: "2026-08-28T14:00:45.000Z",
      bidCentsPerShare: 150,
      askCentsPerShare: 160,
    },
    greeks: {
      deltaMillionths: 300_000,
      gammaMillionths: 20_000,
      thetaMillionths: -100_000,
      vegaMillionths: 150_000,
      impliedVolatilityMillionths: 200_000,
    },
  }),
]

export const createAuditSnapshotPairV1 = (options: Readonly<{
  contracts?: readonly ContractInput[]
  mutateUnderlying?: (
    input: ReturnType<typeof createUnderlyingSnapshotInputV1>,
  ) => void
}> = {}): ValidatedResearchSnapshotPairV1 => {
  const underlyingInput = createUnderlyingSnapshotInputV1()
  underlyingInput.underlyingQuote.bidMicrosPerShare = 636_000_000
  underlyingInput.underlyingQuote.askMicrosPerShare = 636_020_000
  options.mutateUnderlying?.(underlyingInput)
  const underlying = buildUnderlyingSessionSnapshotV1(underlyingInput)
  if (!underlying.success) throw new Error(underlying.reasons.join(","))

  const contracts = options.contracts ?? createEligibleAuditContractsV1()
  const optionInput = createOptionUniverseSnapshotInputV1()
  optionInput.requestedContractSymbols.splice(
    0,
    optionInput.requestedContractSymbols.length,
    ...contracts.map(({ contractSymbol }) => contractSymbol),
  )
  optionInput.contracts.splice(0, optionInput.contracts.length, ...contracts)
  const optionUniverse = buildOptionUniverseSnapshotV1(
    underlying.snapshot,
    optionInput,
  )
  if (!optionUniverse.success) throw new Error(optionUniverse.reasons.join(","))
  const pair = validateResearchSnapshotPairV1(
    underlying.snapshot,
    optionUniverse.snapshot,
  )
  if (!pair.success) throw new Error(pair.reason)
  return pair
}

export const createHistoricalAuditSnapshotPairV1 = () => {
  const pair = createAuditSnapshotPairV1()
  const historicalManifest = {
    ...pair.underlying.strategyManifest,
    components: {
      ...pair.underlying.strategyManifest.components,
      featureCalculation: {
        ...pair.underlying.strategyManifest.components.featureCalculation,
        componentId: "historical-feature-component",
      },
    },
  }
  const { snapshotId: _underlyingId, ...underlyingContent } = pair.underlying
  const historicalUnderlyingContent = {
    ...underlyingContent,
    strategyManifest: historicalManifest,
  }
  const historicalUnderlying = {
    ...historicalUnderlyingContent,
    snapshotId: computeUnderlyingSessionSnapshotIdV1(historicalUnderlyingContent),
  }
  const { snapshotId: _optionId, ...optionContent } = pair.optionUniverse
  const historicalOptionContent = {
    ...optionContent,
    underlyingSnapshotId: historicalUnderlying.snapshotId,
  }
  const historicalOption = {
    ...historicalOptionContent,
    snapshotId: computeOptionUniverseSnapshotIdV1(historicalOptionContent),
  }
  const historicalPair = validateResearchSnapshotPairV1(
    historicalUnderlying,
    historicalOption,
  )
  if (!historicalPair.success) throw new Error(historicalPair.reason)
  return historicalPair
}

export const auditResearchInvocationV1: ResearchInvocationV1 = {
  invocationVersion: "1.3.0",
  agentName: "research",
  cycleMode: "STANDARD",
  promptVersion: "1.4.1",
  skillName: "spy-debit-spread-research",
  skillVersion: "1.2.0",
  strategyVersion: "1.1.0",
  decisionContractVersion: "1.0.0",
  reportVersion: "2.0.0",
  providerId: "openai",
  modelId: "gpt-5.6-sol",
  responseError: false,
  tokens: {},
  tools: {
    totalCount: 0,
    errorCount: 0,
    incompleteCount: 0,
    omittedCount: 0,
    calls: [],
  },
}

export const createAuditResearchReportV2 = (): ResearchReportV2 =>
  researchReportV2Schema.parse({
    reportVersion: "2.0.0",
    result: {
      contractVersion: "1.0.0",
      strategyVersion: "1.1.0",
      outcome: "PROPOSE_TRADE",
      direction: "BULLISH",
      thesis: "Model prose must not enter the audit projection.",
      candidate: {
        underlying: "SPY",
        structure: "BULL_CALL_SPREAD",
        expiration: "2026-09-18",
        longLeg: { contractSymbol: "SPY260918C00630000", strike: 630 },
        shortLeg: { contractSymbol: "SPY260918C00635000", strike: 635 },
      },
      invalidation: ["More model prose that must be excluded."],
      evidence: [{
        claimId: "fact-1",
        kind: "SOURCED_FACT",
        claim: "A model-authored financial claim.",
        snapshotRef: "agent-option-snapshot",
      }],
    },
    analysis: {
      provenance: "AGENT_REPORTED",
      asOf: "2026-08-28T14:01:00.000Z",
      accountChecks: {
        verification: "AGENT_REPORTED",
        observedAt: "2026-08-28T14:00:40.000Z",
        accountStatus: "ACTIVE",
        optionsTradingApproved: true,
        conflictingStrategyExposure: false,
      },
      marketRegime: {
        verification: "AGENT_REPORTED",
        temporalClass: "LIVE",
        observedAt: "2026-08-28T14:00:45.000Z",
        signal: "BULLISH",
        dailyClose: 650,
        sma20: 645,
        sma50: 640,
        sessionVwap: 648,
        spotMidpoint: 651,
        dailySessionCount: 50,
        intradayBarCount: 30,
      },
      candidateEvaluation: {
        verification: "AGENT_REPORTED",
        observedAt: "2026-08-28T14:00:45.000Z",
        dte: 21,
        legs: [
          {
            role: "LONG",
            contractSymbol: "SPY260918C00630000",
            delta: 0.5,
            impliedVolatility: 0.2,
            gamma: 0.02,
            theta: -0.1,
            vega: 0.15,
            volume: 200,
            openInterest: 1_000,
            openInterestDate: "2026-08-27",
          },
          {
            role: "SHORT",
            contractSymbol: "SPY260918C00635000",
            delta: 0.3,
            impliedVolatility: 0.19,
            gamma: 0.015,
            theta: -0.08,
            vega: 0.12,
            volume: 180,
            openInterest: 900,
            openInterestDate: "2026-08-27",
          },
        ],
      },
      externalContext: [{
        sourceId: "exa-1",
        provider: "EXA",
        verification: "AGENT_REPORTED",
        title: "Model-authored title",
        url: "https://example.com/private-path?query=excluded",
        publishedAt: "2026-08-28T13:00:00.000Z",
        retrievedAt: "2026-08-28T14:00:50.000Z",
        summary: "Model-authored summary must be excluded.",
        relevance: "NEUTRAL",
      }],
      supportingFactors: ["excluded"],
      contradictingFactors: ["excluded"],
      conflicts: ["excluded"],
    },
  })

export const IDENTICAL_INPUT_MATCHES_V1: IdenticalInputParityChecksV1 = {
  feature: "MATCH",
  filter: "MATCH",
  ranking: "MATCH",
  candidate: "MATCH",
}

const changedIdentity = (
  identity: ResearchScreeningAuditInputIdentityV1,
  overrides: Partial<ResearchScreeningAuditInputIdentityV1>,
): ResearchScreeningAuditInputIdentityV1 => ({ ...identity, ...overrides })

const mismatchChecks = (
  field: keyof IdenticalInputParityChecksV1,
): IdenticalInputParityChecksV1 => ({
  ...IDENTICAL_INPUT_MATCHES_V1,
  [field]: "MISMATCH",
})

const screenedApplication = (
  pair: ValidatedResearchSnapshotPairV1,
  index: number,
) => createApplicationResearchScreeningAuditV1({
  pair,
  audited: screenSpyDirectionalDebitVerticalWithAuditV1(pair),
  captureDurationMs: 100 + index,
  screeningDurationMs: 10 + index,
})

const noActionApplication = (
  pair: ValidatedResearchSnapshotPairV1,
  index: number,
) => {
  const application = screenedApplication(pair, index)
  if (application.status !== "SCREENED" ||
    application.result.status !== "NO_ACTION") {
    throw new Error("Expected no-action screening fixture")
  }
  return application
}

const availableAgent = () => projectResearchReportV2ForScreeningAudit(
  createAuditResearchReportV2(),
  auditResearchInvocationV1,
)

const screeningAuditCases = (): readonly Readonly<{
  label: string
  audit: ResearchScreeningAuditV1
}>[] => {
  const pair = createAuditSnapshotPairV1()
  const application = screenedApplication(pair, 0)
  const agent = availableAgent()
  const identity = createResearchScreeningAuditInputIdentityV1(pair)
  const audit = (
    label: string,
    selectedApplication: ApplicationResearchScreeningAuditV1,
    selectedAgent: AgentResearchScreeningAuditV1,
    trustedAgentInputIdentity?: ResearchScreeningAuditInputIdentityV1,
    identicalInputChecks?: IdenticalInputParityChecksV1,
  ) => ({
    label,
    audit: createResearchScreeningAuditV1({
      application: selectedApplication,
      agent: selectedAgent,
      ...(trustedAgentInputIdentity === undefined
        ? {}
        : { trustedAgentInputIdentity }),
      ...(identicalInputChecks === undefined ? {} : { identicalInputChecks }),
    }),
  })

  const unavailable = (reason: Parameters<
    typeof createAgentResearchScreeningUnavailableAuditV1
  >[0]) => createAgentResearchScreeningUnavailableAuditV1(reason)
  const drift = (
    reason: "PROVIDER_DRIFT" | "MODEL_DRIFT",
    expected: string,
    observed: string,
  ) => createAgentResearchScreeningModelDriftAuditV1({
    invocationVersion: "1.3.0",
    reason,
    expected,
    observed,
  })

  const noActionPairs = [
    createHistoricalAuditSnapshotPairV1(),
    createAuditSnapshotPairV1({
      mutateUnderlying(input) {
        input.underlyingQuote.bidMicrosPerShare = 635_190_000
        input.underlyingQuote.askMicrosPerShare = 635_200_000
      },
    }),
    createAuditSnapshotPairV1({
      mutateUnderlying(input) {
        input.times.evaluatedAt = "2026-08-28T14:01:31.000Z"
      },
    }),
    createAuditSnapshotPairV1({
      contracts: [createAuditContractV1({
        strikeCentsPerShare: 63_000,
        tradable: false,
      })],
    }),
  ] as const

  return [
    audit("identical-match", application, agent, identity, IDENTICAL_INPUT_MATCHES_V1),
    audit("feature-mismatch", application, agent, identity, mismatchChecks("feature")),
    audit("filter-mismatch", application, agent, identity, mismatchChecks("filter")),
    audit("ranking-mismatch", application, agent, identity, mismatchChecks("ranking")),
    audit("candidate-mismatch", application, agent, identity, mismatchChecks("candidate")),
    audit("different-time", application, agent, changedIdentity(identity, {
      evaluatedAt: "2026-08-28T14:01:01.000Z",
    })),
    audit("different-membership", application, agent, changedIdentity(identity, {
      optionUniverseMembershipId:
        identity.optionUniverseMembershipId === "f".repeat(64)
          ? "e".repeat(64)
          : "f".repeat(64),
    })),
    audit(
      "capture-timeout",
      createApplicationCaptureUnavailableAuditV1([
        "REQUEST_TIMED_OUT",
        "PROVIDER_RATE_LIMITED",
      ], 250),
      unavailable("INVOCATION_FAILED"),
    ),
    audit(
      "capture-cancelled",
      createApplicationCaptureUnavailableAuditV1(["AUDIT_CANCELLED"], 50),
      unavailable("AUDIT_CANCELLED"),
    ),
    audit(
      "screening-unavailable",
      createApplicationScreeningUnavailableAuditV1({
        pair,
        captureDurationMs: 125,
        screeningDurationMs: 25,
        reason: "FEATURE_INPUT_INVALID",
      }),
      unavailable("UNEXPECTED_FAILURE"),
    ),
    audit("agent-unavailable", application, unavailable("REPORT_REJECTED")),
    audit("provider-drift", application, drift("PROVIDER_DRIFT", "openai", "other")),
    audit(
      "model-drift",
      application,
      drift("MODEL_DRIFT", "gpt-5.6-sol", "other-model"),
    ),
    audit("not-representable", application, agent),
    audit(
      "no-action-manifest",
      noActionApplication(noActionPairs[0], 14),
      unavailable("REPORT_REJECTED"),
    ),
    audit(
      "no-action-signal",
      noActionApplication(noActionPairs[1], 15),
      unavailable("REPORT_REJECTED"),
    ),
    audit(
      "no-action-stale",
      noActionApplication(noActionPairs[2], 16),
      unavailable("REPORT_REJECTED"),
    ),
    audit(
      "no-action-no-spread",
      noActionApplication(noActionPairs[3], 17),
      unavailable("REPORT_REJECTED"),
    ),
  ]
}

const stored = (event: LedgerEventV1, sequence: number): StoredLedgerEventV1 => ({
  ...ledgerEventV1Schema.parse(event),
  sequence,
  recordedAt: "2026-08-28T14:02:00.000Z",
})

export const createResearchScreeningAuditReportFixtureEventsV1 = (
  startingSequence = 1,
): readonly StoredLedgerEventV1[] => screeningAuditCases().flatMap(
  ({ audit }, index) => {
    const cycleNumber = index + 1
    const cycleId = `audit-report-cycle-${cycleNumber}`
    const sessionId = "audit-report-session"
    const correlationId = `audit-report-correlation-${cycleNumber}`
    const startEventId = `audit-report-start-${cycleNumber}`
    const terminalEventId = `audit-report-terminal-${cycleNumber}`
    const startSequence = startingSequence + index * 3
    const common = {
      eventVersion: "1.0.0",
      occurredAt: "2026-08-28T14:01:00.000Z",
      correlationId,
      cycleId,
      sessionId,
    } as const
    const start = stored({
      ...common,
      eventId: startEventId,
      eventType: "RESEARCH_CYCLE_STARTED",
      payload: {
        cycleNumber,
        sessionDate: "2026-08-28",
        initialEligibility: {
          evaluatedAt: "2026-08-28T14:00:00.000Z",
          sessionDate: "2026-08-28",
          sessionOpen: "2026-08-28T13:30:00.000Z",
          sessionClose: "2026-08-28T20:00:00.000Z",
          researchEligible: true,
          tradeIntentEligible: true,
          tradeIntentWindow: {
            slotStartedAt: "2026-08-28T14:00:00.000Z",
            deadline: "2026-08-28T14:10:00.000Z",
          },
        },
      },
    }, startSequence)
    const terminal = stored({
      ...common,
      eventId: terminalEventId,
      eventType: "RESEARCH_CYCLE_INTERRUPTED",
      causationEventId: startEventId,
      payload: { reason: "FAILED" },
    }, startSequence + 1)
    const auditEvent = stored({
      ...common,
      eventId: `audit-report-audit-${cycleNumber}`,
      eventType: "RESEARCH_SCREENING_AUDIT_RECORDED",
      causationEventId: terminalEventId,
      payload: { audit },
    }, startSequence + 2)
    return [start, terminal, auditEvent]
  },
)
