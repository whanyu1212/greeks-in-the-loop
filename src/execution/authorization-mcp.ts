import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

import {
  createConfiguredLedgerStore,
  resolveLedgerBackendConfiguration,
} from "../event-ledger/ledger-backend.js"
import { resolveExecutionAuthorizationV1 } from "./authorization-v1.js"

const ledgerPath = process.env.EXECUTION_LEDGER_PATH?.trim()
const backendSetting = process.env.EXECUTION_LEDGER_BACKEND?.trim() ||
  process.env.RESEARCH_LEDGER_BACKEND?.trim() ||
  "sqlite"
if (!ledgerPath && backendSetting === "sqlite") {
  throw new Error("EXECUTION_LEDGER_PATH is required")
}
const ledgerConfiguration = resolveLedgerBackendConfiguration(
  { ...process.env, EXECUTION_LEDGER_BACKEND: backendSetting },
  ledgerPath ?? ".state/research-ledger.sqlite",
  "EXECUTION_LEDGER_BACKEND",
)

const server = new McpServer({
  name: "greeks-execution-authorization",
  version: "1.0.0",
})

server.registerTool(
  "get_authorization",
  {
    description:
      "Resolve one immutable, unexpired Alpaca paper execution authorization by opaque ID.",
    inputSchema: z
      .object({ authorizationId: z.string().min(1).max(128) })
      .strict(),
  },
  async ({ authorizationId }) => {
    const store = await createConfiguredLedgerStore({
      configuration: ledgerConfiguration,
      knownCredentialValues: [process.env.PGPASSWORD?.trim()].filter(
        (value): value is string => value !== undefined && value.length > 0,
      ),
      readonly: true,
      fileMustExist: true,
    })
    try {
      const resolution = await resolveExecutionAuthorizationV1(
        store,
        authorizationId,
      )
      const result = resolution.status === "AUTHORIZED"
        ? { status: resolution.status, authorization: resolution.authorization }
        : resolution
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      }
    } finally {
      await store.close()
    }
  },
)

await server.connect(new StdioServerTransport())
