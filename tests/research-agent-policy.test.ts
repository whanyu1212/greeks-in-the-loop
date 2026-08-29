import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  NO_ACTION_REASON_CODES,
  STRATEGY_VERSION,
} from "../src/contracts/research-decision-v1.js"
import {
  RESEARCH_MAX_AGENT_STEPS,
  RESEARCH_SKILL_NAME,
  RESEARCH_SKILL_VERSION,
} from "../src/research/research-agent.js"

type PermissionAction = "allow" | "ask" | "deny"
type Permission = PermissionAction | Record<string, PermissionAction>

type PackageManifest = {
  scripts?: Record<string, string>
}

type OpenCodeConfig = {
  agent: Record<
    string,
    {
      mode?: string
      permission?: Record<string, Permission>
      prompt?: string
      steps?: number
    }
  >
  default_agent?: string
  mcp: Record<string, { command: string[]; enabled?: boolean }>
  permission?: Record<string, Permission>
  share?: string
}

const manifest = JSON.parse(
  readFileSync("package.json", "utf8"),
) as PackageManifest
const config = JSON.parse(readFileSync("opencode.json", "utf8")) as OpenCodeConfig
const systemPrompt = readFileSync(
  "src/research/research-agent-system.md",
  "utf8",
)
const researchSkill = readFileSync(
  ".opencode/skills/spy-debit-spread-research/SKILL.md",
  "utf8",
)
const sourcePolicy = readFileSync("docs/research-source-policy.md", "utf8")
const mcpLauncher = readFileSync("scripts/run-research-mcp.mjs", "utf8")
const evalMcp = readFileSync("scripts/research-eval-mcp.ts", "utf8")
const evalCli = readFileSync(
  "src/evaluation/research-behavior-evaluate-cli.ts",
  "utf8",
)
const research = config.agent.research
if (!research) throw new Error("research agent is required")
const permission = research.permission ?? {}

describe("research agent policy", () => {
  it("selects the dedicated primary agent and disables session sharing", () => {
    expect(config.default_agent).toBe("research")
    expect(config.share).toBe("disabled")
    expect(research.mode).toBe("primary")
    expect(research.prompt).toBe("{file:./src/research/research-agent-system.md}")
    expect(research.steps).toBe(RESEARCH_MAX_AGENT_STEPS)
  })

  it("denies unknown capabilities and permits only reviewed research MCP patterns", () => {
    expect(permission["*"]).toBe("deny")
    expect(permission["alpaca_get_*"]).toBe("allow")
    expect(permission["fmp_*"]).toBe("allow")
    expect(permission["exa_*"]).toBe("allow")
    expect(permission.trusted_time).toBe("allow")
    expect(config.permission?.["alpaca_*"]).toBe("deny")
  })

  it("denies authority-expanding tools and permits only the strategy skill", () => {
    for (const name of [
      "bash",
      "external_directory",
      "question",
      "task",
      "webfetch",
      "websearch",
    ]) {
      expect(permission[name]).toBe("deny")
    }
    expect(permission.skill).toEqual({
      "*": "deny",
      [RESEARCH_SKILL_NAME]: "allow",
    })
    expect(researchSkill).toContain(`name: ${RESEARCH_SKILL_NAME}`)
    expect(researchSkill).toContain(
      `skill-version: "${RESEARCH_SKILL_VERSION}"`,
    )
  })

  it("keeps checked-in research versions aligned", () => {
    expect(researchSkill).toContain(
      `skill-version: "${RESEARCH_SKILL_VERSION}"`,
    )
    expect(researchSkill).toContain(`strategy-version: "${STRATEGY_VERSION}"`)
    expect(sourcePolicy).toContain(`| Strategy version | \`${STRATEGY_VERSION}\` |`)
    expect(sourcePolicy).not.toContain("Future risk engine")
  })

  it("limits file reads and edits to reviewed project paths", () => {
    expect(permission.read).toEqual({
      "*": "deny",
      "docs/**": "allow",
      "workspace/**": "allow",
    })
    expect(permission.edit).toEqual({
      "*": "deny",
      "workspace/**": "allow",
    })
  })

  it("contains no approval prompts in the unattended agent policy", () => {
    expect(JSON.stringify(permission)).not.toContain('"ask"')
  })

  it("provides every canonical no-action code without exposing source files", () => {
    for (const reasonCode of NO_ACTION_REASON_CODES) {
      expect(systemPrompt).toContain(`\`${reasonCode}\``)
      expect(researchSkill).toContain(`\`${reasonCode}\``)
    }
  })

  it("runs policy, MCP, and behavior diagnostics through reviewed entrypoints", () => {
    expect(manifest.scripts?.["agent:config"]).toContain(
      "scripts/run-isolated-opencode.mjs",
    )
    expect(manifest.scripts?.["agent:mcp"]).toContain(
      "scripts/run-isolated-opencode.mjs",
    )
    expect(manifest.scripts?.["research:eval"]).toBe(
      "vitest run tests/research-behavior-evaluation.test.ts",
    )
    expect(manifest.scripts?.["research:eval:live"]).toBe(
      "tsx src/evaluation/research-behavior-evaluate-cli.ts",
    )
  })

  it("preserves standard proxy and custom-CA connectivity settings", () => {
    for (const setting of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_DIR",
      "SSL_CERT_FILE",
    ]) {
      expect(mcpLauncher).toContain(`"${setting}"`)
    }
    expect(mcpLauncher).toContain('"--enable-proxy"')
  })

  it("keeps the real FMP API key out of OS-visible child arguments", () => {
    expect(mcpLauncher).toContain(
      '"https://financialmodelingprep.com/mcp?apikey=${FMP_API_KEY}"',
    )
    expect(mcpLauncher).toContain('require.resolve("mcp-remote/package.json")')
    expect(mcpLauncher).toContain('"--require"')
    expect(mcpLauncher).toContain('"--silent"')
    expect(mcpLauncher).not.toContain(
      "mcp?apikey=${readRequiredSetting",
    )
  })

  it("keeps live behavior evaluation isolated from production credentials", () => {
    for (const setting of [
      "ALPACA_API_KEY",
      "ALPACA_SECRET_KEY",
      "FMP_API_KEY",
      "EXA_API_KEY",
    ]) {
      expect(evalMcp).not.toContain(setting)
      expect(evalCli).not.toContain(`process.env.${setting}`)
    }
    expect(evalCli).toContain("greeks-research-eval-")
    expect(evalCli).toContain("workspace/research-evals")
    expect(evalMcp).toContain("McpServer")
    expect(evalMcp).toContain("StdioServerTransport")
    expect(evalMcp).toContain('start: z.string().datetime({ offset: true })')
    expect(evalMcp).toContain('end: z.string().datetime({ offset: true })')
    expect(evalMcp).toContain("Stock-bar start must precede end")
    expect(evalMcp).toContain("spyAlpacaOptionSymbolV1Schema")
    expect(evalMcp).not.toContain('.startsWith("SPY")')
    expect(evalMcp).not.toContain("/^SPY\\d{6}")
    expect(evalMcp).toContain("withinRequestedWindow")
    expect(evalMcp).toContain("instant >= requestedStart && instant < requestedEnd")
  })

  it("enables only the four approved research MCP servers through the launcher", () => {
    expect(Object.keys(config.mcp).sort()).toEqual([
      "alpaca",
      "exa",
      "fmp",
      "trusted",
    ])
    for (const [name, server] of Object.entries(config.mcp)) {
      expect(server.enabled).toBe(true)
      expect(server.command).toEqual(["node", "scripts/run-research-mcp.mjs", name])
    }
  })
})
