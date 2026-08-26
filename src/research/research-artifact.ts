import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { z } from "zod"

import type { ResearchCycleOutcomeV1 } from "./research-cycle-outcome-v1.js"
import type { ResearchReportV2 } from "../contracts/research-report-v2.js"

export const RESEARCH_ARTIFACT_VERSION = "1.0.0" as const
export const DEFAULT_RESEARCH_ARTIFACT_ROOT = "workspace/research" as const

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)

export type WriteResearchCycleArtifactOptions = Readonly<{
  cycleId: string
  cycleNumber: number
  sessionDate: string
  outcome: ResearchCycleOutcomeV1
  researchReport?: ResearchReportV2
  root?: string
  now?: () => Date
}>

/** Writes one inspection-only artifact from an already validated cycle outcome. */
export async function writeResearchCycleArtifact({
  cycleId,
  cycleNumber,
  sessionDate,
  outcome,
  researchReport,
  root = DEFAULT_RESEARCH_ARTIFACT_ROOT,
  now = () => new Date(),
}: WriteResearchCycleArtifactOptions): Promise<string> {
  const parsedCycleId = identifier.parse(cycleId)
  const parsedSessionDate = z.iso.date().parse(sessionDate)
  if (!Number.isSafeInteger(cycleNumber) || cycleNumber <= 0) {
    throw new Error("Research artifact cycle number is invalid")
  }
  const generatedAt = now()
  if (!Number.isFinite(generatedAt.getTime())) {
    throw new Error("Research artifact generation time is invalid")
  }

  const directory = join(root, parsedSessionDate)
  const path = join(
    directory,
    `cycle-${cycleNumber}-${parsedCycleId}.json`,
  )
  await mkdir(directory, { recursive: true })
  await writeFile(
    path,
    `${JSON.stringify(
      {
        artifactVersion: RESEARCH_ARTIFACT_VERSION,
        generatedAt: generatedAt.toISOString(),
        sessionDate: parsedSessionDate,
        cycleId: parsedCycleId,
        cycleNumber,
        outcome,
        ...(researchReport === undefined ? {} : { researchReport }),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx" },
  )
  return path
}
