import { describe, expect, it } from "vitest"

import { resolveLedgerBackendConfiguration } from "../src/event-ledger/ledger-backend.js"

describe("ledger backend configuration", () => {
  it("keeps SQLite as the local default", () => {
    expect(resolveLedgerBackendConfiguration({}, ".state/ledger.sqlite")).toEqual({
      backend: "sqlite",
      path: ".state/ledger.sqlite",
    })
  })

  it("accepts a PostgreSQL connection string without exposing it", () => {
    const connectionString = "postgresql://user:secret@localhost/research"
    expect(
      resolveLedgerBackendConfiguration(
        {
          RESEARCH_LEDGER_BACKEND: "postgres",
          DATABASE_URL: connectionString,
        },
        "unused.sqlite",
      ),
    ).toEqual({ backend: "postgres", poolConfig: { connectionString } })
  })

  it("builds Cloud SQL Unix-socket configuration from PG settings", () => {
    expect(
      resolveLedgerBackendConfiguration(
        {
          RESEARCH_LEDGER_BACKEND: "postgres",
          PGHOST: "/cloudsql/project:region:instance",
          PGPORT: "5432",
          PGDATABASE: "research",
          PGUSER: "worker",
          PGPASSWORD: "secret",
        },
        "unused.sqlite",
      ),
    ).toEqual({
      backend: "postgres",
      poolConfig: {
        host: "/cloudsql/project:region:instance",
        port: 5432,
        database: "research",
        user: "worker",
        password: "secret",
      },
    })
  })

  it("fails closed on incomplete or unknown backend settings", () => {
    expect(() =>
      resolveLedgerBackendConfiguration(
        { RESEARCH_LEDGER_BACKEND: "other" },
        "unused.sqlite",
      ),
    ).toThrow("RESEARCH_LEDGER_BACKEND must be sqlite or postgres")
    expect(() =>
      resolveLedgerBackendConfiguration(
        { RESEARCH_LEDGER_BACKEND: "postgres" },
        "unused.sqlite",
      ),
    ).toThrow("PGHOST is required")
  })
})
