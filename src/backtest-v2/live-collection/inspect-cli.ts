import Database from "better-sqlite3"

const args = process.argv.slice(2)
const databaseIndex = args.indexOf("--database")
const databasePath = databaseIndex < 0 ? undefined : args[databaseIndex + 1]
if (databasePath === undefined || databasePath.startsWith("--")) {
  throw new Error("--database <path> is required")
}
if (args.length !== 2 || databaseIndex !== 0) {
  throw new Error("Usage: --database <path>")
}

const database = new Database(databasePath, { readonly: true, fileMustExist: true })
try {
  database.pragma("query_only = ON")
  const count = (table: string) =>
    (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
  const latestRun = database.prepare(`
    SELECT run_id, mode, status, session_date, started_at, completed_at, failure_code
    FROM collection_runs
    ORDER BY started_at DESC, run_id DESC
    LIMIT 1
  `).get()
  const latestBootstrap = database.prepare(`
    SELECT bootstrap_id, retrieved_at, spot_count, provider_contract_count,
           retained_contract_count
    FROM contract_bootstraps
    ORDER BY retrieved_at DESC, bootstrap_id DESC
    LIMIT 1
  `).get()
  const latestPoll = database.prepare(`
    SELECT poll_id, scheduled_at, session_state, requested_contract_count,
           received_contract_count, fresh_count, stale_count, invalid_count, status,
           failure_code
    FROM quote_poll_attempts
    ORDER BY scheduled_at DESC, poll_id DESC
    LIMIT 1
  `).get()
  const quality = database.prepare(`
    SELECT quality, COUNT(*) AS count
    FROM option_quote_observations
    GROUP BY quality
    ORDER BY quality
  `).all()
  process.stdout.write(`${JSON.stringify({
    databasePath,
    integrityCheck: database.pragma("integrity_check", { simple: true }),
    counts: {
      runs: count("collection_runs"),
      bootstraps: count("contract_bootstraps"),
      contracts: count("option_contracts"),
      polls: count("quote_poll_attempts"),
      quoteObservations: count("option_quote_observations"),
      researchArtifacts: count("research_artifacts"),
    },
    latestRun,
    latestBootstrap,
    latestPoll,
    quoteQuality: quality,
  }, null, 2)}\n`)
} finally {
  database.close()
}
