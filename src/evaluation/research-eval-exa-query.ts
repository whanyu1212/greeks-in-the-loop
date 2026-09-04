export type ResearchEvalExaQueryDirection = "SUPPORTS" | "CHALLENGES"

export const researchEvalExaSourceIndex = (
  scenarioId: string,
  direction: ResearchEvalExaQueryDirection | undefined,
): 1 | 2 =>
  scenarioId === "weak-evidence-no-action" || direction !== "CHALLENGES"
    ? 1
    : 2

const supportTerms = /\b(?:bullish|positive|support(?:s|ed|ing)?|upside)\b/iu
const challengeTerms =
  /\b(?:bearish|challenge(?:s|d|ing)?|concerns?|contradict(?:s|ed|ing|ions?|ory)?|downside|negative|risks?)\b/iu

export const researchEvalExaQueryDirection = (
  query: string,
  expectedSymbol: string,
): ResearchEvalExaQueryDirection | undefined => {
  const querySymbols: readonly string[] =
    query.toUpperCase().match(/[A-Z]+/gu) ?? []
  if (!querySymbols.includes(expectedSymbol.toUpperCase())) return undefined
  const supports = supportTerms.test(query)
  const challenges = challengeTerms.test(query)
  if (supports === challenges) return undefined
  return supports ? "SUPPORTS" : "CHALLENGES"
}
