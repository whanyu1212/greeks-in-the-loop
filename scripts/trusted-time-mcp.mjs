import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer({
  name: "greeks-trusted-time",
  version: "1.0.0",
})

server.registerTool(
  "time",
  {
    description: "Return the application host's current UTC response-completion time.",
    inputSchema: z.object({}).strict(),
  },
  async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({ utc: new Date().toISOString() }),
    }],
  }),
)

await server.connect(new StdioServerTransport())
