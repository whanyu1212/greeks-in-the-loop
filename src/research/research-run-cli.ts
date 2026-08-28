import { existsSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

import { parse as parseEnv } from "dotenv"

import { createSqliteLedgerStore } from "../event-ledger/sqlite-ledger-store.js"
import { loadResearchRunV1 } from "./research-artifact.js"
import {
  buildResearchRunPresentation,
  writeResearchRunArtifacts,
} from "./research-run-presentation.js"

export type ResearchRunOutputFormat = "json" | "markdown"

export type ResearchRunCliOptions = Readonly<{
  ledgerPath: string
  cycleId?: string
  exportArtifact: boolean
  root?: string
  force: boolean
  format: ResearchRunOutputFormat
}>

const usage = `Usage: pnpm research:run [options]

Read a completed research run from the authoritative SQLite ledger.

Options:
  --ledger <path>   Ledger path (default: RESEARCH_LEDGER_PATH from the environment or .env)
  --cycle <id>      Cycle to read (default: latest completed cycle)
  --export          Write the JSON artifact and Markdown brief
  --format <value>  Output format: json or markdown (default: json)
  --root <path>     Artifact root used with --export (default: workspace/research)
  --force           Replace an existing artifact used with --export
  --help            Show this help
`

const fileEnv = (() => {
  try {
    return parseEnv(readFileSync(".env"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
})()

export const parseResearchRunCliOptions = (
  args: readonly string[],
): ResearchRunCliOptions => {
  let ledgerPath =
    (process.env.RESEARCH_LEDGER_PATH ?? fileEnv.RESEARCH_LEDGER_PATH)?.trim() ||
    ".state/research-ledger.sqlite"
  let cycleId: string | undefined
  let exportArtifact = false
  let root: string | undefined
  let force = false
  let format: ResearchRunOutputFormat = "json"

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--") continue
    if (argument === "--help") {
      console.log(usage)
      process.exit(0)
    }
    if (argument === "--export") {
      exportArtifact = true
      continue
    }
    if (argument === "--force") {
      force = true
      continue
    }
    if (
      argument === "--ledger" ||
      argument === "--cycle" ||
      argument === "--root" ||
      argument === "--format"
    ) {
      const value = args[++index]?.trim()
      if (!value) throw new Error(`${argument} requires a value`)
      if (argument === "--ledger") ledgerPath = value
      if (argument === "--cycle") cycleId = value
      if (argument === "--root") root = value
      if (argument === "--format") {
        if (value !== "json" && value !== "markdown") {
          throw new Error("--format must be json or markdown")
        }
        format = value
      }
      continue
    }
    throw new Error(`Unknown option: ${argument ?? ""}`)
  }

  return {
    ledgerPath,
    ...(cycleId === undefined ? {} : { cycleId }),
    exportArtifact,
    ...(root === undefined ? {} : { root }),
    force,
    format,
  }
}

export async function runResearchRunCli(args: readonly string[]) {
  const options = parseResearchRunCliOptions(args)
  if (!existsSync(options.ledgerPath)) {
    throw new Error(`Research ledger does not exist: ${options.ledgerPath}`)
  }

  const store = createSqliteLedgerStore({
    path: options.ledgerPath,
    knownCredentialValues: [],
  })
  try {
    await store.migrate()
    const cycleId =
      options.cycleId ??
      (
        await store.list({
          eventTypes: ["RESEARCH_CYCLE_COMPLETED"],
          direction: "DESC",
          limit: 1,
        })
      )[0]?.cycleId
    if (cycleId === undefined) {
      throw new Error("No completed research cycle was found")
    }

    const run = await loadResearchRunV1(store, cycleId)
    if (options.exportArtifact) {
      const artifacts = await writeResearchRunArtifacts({
        run,
        ...(options.root === undefined ? {} : { root: options.root }),
        overwrite: options.force,
      })
      console.log(
        options.format === "markdown"
          ? artifacts.markdownPath
          : artifacts.jsonPath,
      )
    } else if (options.format === "markdown") {
      process.stdout.write(buildResearchRunPresentation(run).markdown)
    } else {
      console.log(JSON.stringify(run, null, 2))
    }
  } finally {
    await store.close()
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runResearchRunCli(process.argv.slice(2))
}
