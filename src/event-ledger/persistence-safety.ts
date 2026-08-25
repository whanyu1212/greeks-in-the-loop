const PROHIBITED_STRING_PATTERN =
  /(?:\bBearer\s+[A-Za-z0-9._~+/-]{8,}|\b(?:api[_-]?key|apikey|(?:access|refresh|id|security|session)?[_-]?token|authorization|client[_-]?secret|credentials?|password|signature)\s*[:=]\s*\S{4,})/iu

const PROHIBITED_NORMALIZED_KEYS = new Set([
  "env",
  "environment",
  "header",
  "headers",
  "key",
  "requestheader",
  "requestheaders",
])
const PROHIBITED_KEY_SUFFIXES = [
  "accesskey",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "password",
  "privatekey",
  "secret",
  "secretkey",
  "signature",
  "token",
] as const

const isProhibitedKey = (key: string) => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "")
  return (
    PROHIBITED_NORMALIZED_KEYS.has(normalized) ||
    PROHIBITED_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  )
}

export class UnsafePersistencePayloadError extends Error {
  constructor(path: readonly (string | number)[]) {
    super(`Unsafe persistence payload at ${path.length === 0 ? "<root>" : path.join(".")}`)
    this.name = "UnsafePersistencePayloadError"
  }
}

const assertSafeUrl = (value: string, path: readonly (string | number)[]) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return
  }

  if (url.username || url.password) {
    throw new UnsafePersistencePayloadError(path)
  }

  const assertSafeParameterKeys = (parameters: URLSearchParams) => {
    for (const key of parameters.keys()) {
      let decodedKey: string
      try {
        decodedKey = decodeURIComponent(key)
      } catch {
        throw new UnsafePersistencePayloadError(path)
      }
      if (isProhibitedKey(decodedKey)) {
        throw new UnsafePersistencePayloadError(path)
      }
    }
  }

  assertSafeParameterKeys(url.searchParams)
  if (url.hash.length > 1) {
    assertSafeParameterKeys(new URLSearchParams(url.hash.slice(1)))
  }
}

const visit = (
  value: unknown,
  path: readonly (string | number)[],
  ancestors: Set<object>,
): void => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "string") {
      if (PROHIBITED_STRING_PATTERN.test(value)) {
        throw new UnsafePersistencePayloadError(path)
      }
      assertSafeUrl(value, path)
    }
    return
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UnsafePersistencePayloadError(path)
    return
  }

  if (
    typeof value === "undefined" ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new UnsafePersistencePayloadError(path)
  }

  if (ancestors.has(value)) throw new UnsafePersistencePayloadError(path)
  ancestors.add(value)

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      visit(item, [...path, index], ancestors)
    }
    ancestors.delete(value)
    return
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new UnsafePersistencePayloadError(path)
  }

  for (const [key, item] of Object.entries(value)) {
    if (isProhibitedKey(key)) {
      throw new UnsafePersistencePayloadError([...path, key])
    }
    visit(item, [...path, key], ancestors)
  }
  ancestors.delete(value)
}

/**
 * Rejects non-JSON values and likely secret-bearing keys or URLs.
 *
 * The original payload is never included in the thrown error.
 */
export function assertPersistenceSafe(value: unknown): void {
  visit(value, [], new Set())
}
