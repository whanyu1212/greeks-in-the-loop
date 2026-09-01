import type { PoolConfig } from "pg"

import type { LedgerStore } from "./ledger-store.js"
import { createPostgresLedgerStore } from "./postgres-ledger-store.js"

export const LEDGER_BACKENDS = ["sqlite", "postgres"] as const
export type LedgerBackend = (typeof LEDGER_BACKENDS)[number]

export type LedgerBackendConfiguration =
  | Readonly<{ backend: "sqlite"; path: string }>
  | Readonly<{ backend: "postgres"; poolConfig: PoolConfig }>

type Settings = Readonly<Record<string, string | undefined>>

const required = (settings: Settings, name: string) => {
  const value = settings[name]?.trim()
  if (!value) throw new Error(`${name} is required for the PostgreSQL ledger`)
  return value
}

/** Resolves an explicit ledger backend without logging connection secrets. */
export function resolveLedgerBackendConfiguration(
  settings: Settings,
  sqlitePath: string,
  backendSetting = "RESEARCH_LEDGER_BACKEND",
): LedgerBackendConfiguration {
  const configured = settings[backendSetting]?.trim().toLowerCase() || "sqlite"
  if (configured === "sqlite") return { backend: "sqlite", path: sqlitePath }
  if (configured !== "postgres") {
    throw new Error(`${backendSetting} must be sqlite or postgres`)
  }

  const connectionString = settings.DATABASE_URL?.trim()
  if (connectionString) {
    return {
      backend: "postgres",
      poolConfig: { connectionString },
    }
  }

  const portValue = settings.PGPORT?.trim() || "5432"
  const port = Number(portValue)
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("PGPORT must be a valid TCP port")
  }
  return {
    backend: "postgres",
    poolConfig: {
      host: required(settings, "PGHOST"),
      port,
      database: required(settings, "PGDATABASE"),
      user: required(settings, "PGUSER"),
      password: required(settings, "PGPASSWORD"),
    },
  }
}

export type CreateConfiguredLedgerStoreOptions = Readonly<{
  configuration: LedgerBackendConfiguration
  knownCredentialValues: readonly string[]
  readonly?: boolean
  fileMustExist?: boolean
}>

/** Creates the selected ledger adapter while keeping callers backend-neutral. */
export async function createConfiguredLedgerStore({
  configuration,
  knownCredentialValues,
  readonly = false,
  fileMustExist = false,
}: CreateConfiguredLedgerStoreOptions): Promise<LedgerStore> {
  if (configuration.backend === "postgres") {
    return createPostgresLedgerStore({
      poolConfig: configuration.poolConfig,
      knownCredentialValues,
      readonly,
    })
  }

  const { createSqliteLedgerStore } = await import(
    "./deprecated/sqlite-ledger-store.js"
  )
  return createSqliteLedgerStore({
    path: configuration.path,
    knownCredentialValues,
    readonly,
    fileMustExist,
  })
}
