import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

import { createSqliteLedgerStore } from "../event-ledger/sqlite-ledger-store.js"
import { resolveExecutionAuthorizationV1 } from "./authorization-v1.js"

const ledgerPath = process.env.EXECUTION_LEDGER_PATH?.trim()
if (!ledgerPath) throw new Error("EXECUTION_LEDGER_PATH is required")

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
    const store = createSqliteLedgerStore({
      path: ledgerPath,
      knownCredentialValues: [],
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
