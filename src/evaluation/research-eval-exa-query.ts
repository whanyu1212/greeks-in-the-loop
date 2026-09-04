export type ResearchEvalExaQueryDirection = "SUPPORTS" | "CHALLENGES"

const supportTerms = /\b(?:bullish|positive|support(?:s|ed|ing)?|upside)\b/iu
const challengeTerms =
  /\b(?:bearish|challenge(?:s|d|ing)?|concerns?|downside|negative|risks?)\b/iu

export const researchEvalExaQueryDirection = (
  query: string,
): ResearchEvalExaQueryDirection | undefined => {
  const supports = supportTerms.test(query)
  const challenges = challengeTerms.test(query)
  if (supports === challenges) return undefined
  return supports ? "SUPPORTS" : "CHALLENGES"
}
