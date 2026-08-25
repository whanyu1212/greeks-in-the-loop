/**
 * Expands the FMP key inside the mcp-remote process, after OS argv is created.
 *
 * The launcher passes a literal `${FMP_API_KEY}` placeholder, so process
 * listings never contain the credential. This preload runs before mcp-remote
 * parses or logs its arguments and replaces only that exact placeholder.
 */

const key = process.env.FMP_API_KEY?.trim()
if (!key) throw new Error("FMP_API_KEY is required")

process.argv = process.argv.map((argument) =>
  argument.replaceAll("${FMP_API_KEY}", encodeURIComponent(key)),
)
