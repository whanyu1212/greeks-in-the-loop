import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
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
const mcpLauncher = readFileSync("scripts/run-research-mcp.mjs", "utf8")
const research = config.agent.research
if (!research) throw new Error("research agent is required")
const permission = research.permission ?? {}

describe("research agent policy", () => {
  it("selects the dedicated primary agent and disables session sharing", () => {
    expect(config.default_agent).toBe("research")
    expect(config.share).toBe("disabled")
    expect(research.mode).toBe("primary")
    expect(research.prompt).toBe("{file:./src/research/research-agent-system.md}")
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

  it("provides every supported no-action code without exposing source files", () => {
    for (const reasonCode of [
      "MARKET_WINDOW_INELIGIBLE",
      "ACCOUNT_STATE_INELIGIBLE",
      "POSITION_OR_RISK_LIMIT_ACTIVE",
      "INSUFFICIENT_UNDERLYING_DATA",
      "REQUIRED_ALPACA_DATA_INVALID",
      "SIGNAL_NOT_ACTIONABLE",
      "NO_ELIGIBLE_SPREAD",
      "CANDIDATE_CHANGED",
      "EXACT_RISK_INPUTS_UNAVAILABLE",
      "CONTRACT_UNREPRESENTABLE",
    ]) {
      expect(systemPrompt).toContain(`\`${reasonCode}\``)
    }
  })

  it("runs policy and MCP diagnostics with the isolated configuration", () => {
    expect(manifest.scripts?.["agent:config"]).toContain(
      "scripts/run-isolated-opencode.mjs",
    )
    expect(manifest.scripts?.["agent:mcp"]).toContain(
      "scripts/run-isolated-opencode.mjs",
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

  it("enables only the three research MCP servers through the credential launcher", () => {
    expect(Object.keys(config.mcp).sort()).toEqual(["alpaca", "exa", "fmp"])
    for (const [name, server] of Object.entries(config.mcp)) {
      expect(server.enabled).toBe(true)
      expect(server.command).toEqual(["node", "scripts/run-research-mcp.mjs", name])
    }
  })
})
