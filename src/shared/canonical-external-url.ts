/** Canonicalizes an external URL for source-identity comparisons. */
export function canonicalExternalUrl(value: string): string {
  const url = new URL(value)
  url.hash = ""
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_.+|gclid|fbclid)$/iu.test(key)) url.searchParams.delete(key)
  }
  url.hostname = url.hostname.toLowerCase()
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/u, "")
  url.searchParams.sort()
  return url.toString()
}