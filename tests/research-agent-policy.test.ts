import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { NO_ACTION_REASON_CODES } from "../src/contracts/research-decision-v3.js"
import { RESEARCH_MAX_AGENT_STEPS } from "../src/research/agent.js"

type PermissionAction = "allow" | "ask" | "deny"

type PackageManifest = {
  scripts?: Record<string, string>
}

type OpenCodeConfig = {
  agent?: unknown
  default_agent?: string
  mcp: Record<string, { command: string[]; enabled?: boolean }>
  permission?: Record<string, PermissionAction>
  share?: string
}

const readAgentDefinition = (path: string) => {
  const source = readFileSync(path, "utf8")
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(source)
  if (!match) throw new Error(`Invalid OpenCode agent definition: ${path}`)
  return { frontmatter: match[1]!, prompt: match[2]! }
}

const hasFrontmatterLine = (frontmatter: string, line: string) =>
  frontmatter.split(/\r?\n/u).includes(line)

const manifest = JSON.parse(
  readFileSync("package.json", "utf8"),
) as PackageManifest
const config = JSON.parse(readFileSync("opencode.json", "utf8")) as OpenCodeConfig
const research = readAgentDefinition(".opencode/agents/research.md")
const trader = readAgentDefinition(".opencode/agents/trader.md")
const systemPrompt = research.prompt
const mcpLauncher = readFileSync("scripts/run-research-mcp.mjs", "utf8")
const evalMcp = readFileSync("scripts/research-eval-mcp.ts", "utf8")
const evalCli = readFileSync(
  "src/evaluation/research-behavior-evaluate-cli.ts",
  "utf8",
)
describe("research agent policy", () => {
  it("selects the dedicated primary agent and disables session sharing", () => {
    expect(config.default_agent).toBe("research")
    expect(config.share).toBe("disabled")
    expect(config.agent).toBeUndefined()
    expect(hasFrontmatterLine(research.frontmatter, "mode: primary")).toBe(true)
    expect(hasFrontmatterLine(research.frontmatter, `steps: ${RESEARCH_MAX_AGENT_STEPS}`)).toBe(true)
    expect(hasFrontmatterLine(research.frontmatter, "model: openai/gpt-5.6-terra")).toBe(true)
    expect(hasFrontmatterLine(research.frontmatter, "  reasoningEffort: xhigh")).toBe(true)
  })

  it("denies unknown capabilities and permits only reviewed research MCP patterns", () => {
    for (const line of [
      '  "*": deny',
      '  "alpaca_get_*": allow',
      '  "fmp_*": allow',
      '  "exa_*": allow',
      "  trusted_time: allow",
    ]) expect(hasFrontmatterLine(research.frontmatter, line)).toBe(true)
    expect(config.permission?.["*"]).toBe("deny")
  })

  it("denies authority-expanding tools", () => {
    for (const name of [
      "bash",
      "external_directory",
      "question",
      "task",
      "webfetch",
      "websearch",
    ]) {
      expect(hasFrontmatterLine(research.frontmatter, `  ${name}: deny`)).toBe(true)
    }
    expect(hasFrontmatterLine(research.frontmatter, "  skill: deny")).toBe(true)
  })

  it("separates paper option submission into a minimal trader agent", () => {
    expect(hasFrontmatterLine(trader.frontmatter, "mode: primary")).toBe(true)
    expect(hasFrontmatterLine(trader.frontmatter, '  "alpaca_get_*": allow')).toBe(true)
    expect(hasFrontmatterLine(trader.frontmatter, "  alpaca_place_option_order: allow")).toBe(true)
    expect(hasFrontmatterLine(trader.frontmatter, "  execution_get_authorization: allow")).toBe(true)
    expect(trader.frontmatter).not.toContain("alpaca_place_stock_order")
    expect(trader.frontmatter).not.toContain("alpaca_place_crypto_order")
    expect(trader.frontmatter).not.toContain("alpaca_cancel_")
    expect(trader.frontmatter).not.toContain('"fmp_*"')
    expect(trader.frontmatter).not.toContain('"exa_*"')
    expect(trader.prompt).toContain("Alpaca paper-trading system")
    expect(trader.prompt).toContain("Submit at most once")
    expect(trader.prompt).toContain("opaque authorization ID")
    expect(trader.prompt).toContain("ALPACA_PAPER")
    expect(trader.prompt).toContain("no authority to place stock or crypto orders")
  })

  it("keeps strategy selection inside the generic research prompt", () => {
    expect(systemPrompt).toContain("dynamic shortlist containing zero through eight symbols")
    expect(systemPrompt).toContain("Promote no more than three symbols")
    expect(systemPrompt).toContain("symbol-strategy screen")
    expect(systemPrompt).toContain("Propose only an exact pair")
    expect(systemPrompt).toContain("APPLICATION_SUPPORT_PENDING")
    expect(systemPrompt).toContain("catalog entry describes a representable Alpaca order shape")
    expect(systemPrompt).toContain("Account approval and buying power are eligibility observations only")
    expect(systemPrompt).not.toContain("spy-debit-spread-research")
  })

  it("limits file reads and edits to reviewed project paths", () => {
    expect(research.frontmatter).toContain([
      "  read:",
      '    "*": deny',
      '    "docs/**": allow',
      '    "docs/.vitepress/**": deny',
      '    "workspace/**": allow',
    ].join("\n"))
    expect(research.frontmatter).toContain([
      "  edit:",
      '    "*": deny',
      '    "workspace/**": allow',
    ].join("\n"))
    expect(hasFrontmatterLine(trader.frontmatter, "  read: deny")).toBe(true)
    expect(hasFrontmatterLine(trader.frontmatter, "  edit: deny")).toBe(true)
  })

  it("contains no approval prompts in the unattended agent policy", () => {
    expect(research.frontmatter).not.toMatch(/:\s+ask$/mu)
    expect(trader.frontmatter).not.toMatch(/:\s+ask$/mu)
  })

  it("provides every canonical no-action code without exposing source files", () => {
    for (const reasonCode of NO_ACTION_REASON_CODES) {
      expect(systemPrompt).toContain(`\`${reasonCode}\``)
    }
  })

  it("requires concrete provider-attributed no-action evidence", () => {
    expect(systemPrompt).toContain("return non-empty `reasonCodes` and `evidence` arrays")
    expect(systemPrompt).toContain("it never uses `snapshotRef`")
    expect(systemPrompt).toContain('kind:"SOURCED_FACT"')
    expect(systemPrompt).toContain('kind:"INFERENCE"')
  })

  it("pins strict report field names and case-sensitive enums", () => {
    expect(systemPrompt).toContain("This section is the authoritative output contract")
    expect(systemPrompt).toContain("`LIVE`, `DELAYED`, or `PRIOR_CLOSE`")
    expect(systemPrompt).toContain("`BULLISH`, `BEARISH`, or `NEUTRAL`")
    expect(systemPrompt).toContain("Use `benchmark`, not `underlying`")
    expect(systemPrompt).toContain('provider:"EXA"')
    expect(systemPrompt).toContain('provider:"FMP"')
    expect(systemPrompt).toContain("Do not substitute provider payload field names")
  })

  it("spells out the strict ordered candidate-leg intents", () => {
    expect(systemPrompt).toContain("one through four ordered opening legs")
    expect(systemPrompt).toContain("simplest-form positive ratios")
  })

  it("defines spread-Greek arithmetic and comparison criteria", () => {
    expect(systemPrompt).toContain("position-weighted sum")
    expect(systemPrompt).toContain("Bullish net delta must be 0.10 through 0.70")
    expect(systemPrompt).toContain("bearish net delta -0.70 through -0.10")
    expect(systemPrompt).toContain("theta cost")
    expect(systemPrompt).toContain("vega exposure")
    expect(systemPrompt).toContain("deterministic code independently recomputes")
  })

  it("uses orthogonal option-surface, event, and underlying evidence", () => {
    for (const field of [
      "atrPercent20",
      "ewmaRealizedVolatility20",
      "ivRvVarianceSpread",
      "termStructureSlope",
      "putCallSkew25Delta",
      "impliedMovePercent",
      "eventBeforeExpiration",
    ]) expect(systemPrompt).toContain(field)
    expect(systemPrompt).toContain("Do not infer `CLEAR` from silence")
    expect(systemPrompt).toContain("RSI, MACD, stochastic")
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
    expect(evalMcp).toContain("alpacaOptionSymbolSchema")
    expect(evalMcp).toContain('"alpaca_get_account_info"')
    expect(evalMcp).toContain('"alpaca_get_account_config"')
    expect(evalMcp).toContain('"alpaca_get_option_snapshot"')
    expect(evalMcp).toContain('"fmp_economics"')
    expect(evalMcp).toContain('"fmp_calendar"')
    expect(evalMcp).toContain('"exa_web_search_exa"')
    expect(evalMcp).not.toContain('"alpaca_get_account_configurations"')
    expect(evalMcp).not.toContain('"fmp_get_economic_calendar"')
    expect(evalMcp).not.toContain('"exa_search"')
    expect(evalMcp).not.toContain('.startsWith("SPY")')
    expect(evalMcp).not.toContain("/^SPY\\d{6}")
    expect(evalMcp).toContain("withinRequestedWindow")
    expect(evalMcp).toContain("instant >= requestedStart && instant < requestedEnd")
  })

  it("enables only the approved isolated MCP servers through the launcher", () => {
    expect(mcpLauncher).toContain('"alpaca-mcp-server==2.2.1"')
    expect(mcpLauncher).toContain('"fastmcp==3.4.7"')
    expect(Object.keys(config.mcp).sort()).toEqual([
      "alpaca",
      "exa",
      "execution",
      "fmp",
      "trusted",
    ])
    for (const [name, server] of Object.entries(config.mcp)) {
      expect(server.enabled).toBe(true)
      expect(server.command).toEqual([
        "node",
        "scripts/run-research-mcp.mjs",
        name === "execution" ? "authorization" : name,
      ])
    }
  })
})
