const PROHIBITED_STRING_PATTERN =
  /(?:^|[^A-Za-z0-9])(?:Bearer\s+\S+|(?:api[_-]?key|apikey|(?:access|refresh|id|security|session)?[_-]?token|authorization|proxy[_-]?authorization|client[_-]?secret|cookies?|set[_-]?cookie|credentials?|password|private[_-]?key|secret(?:[_-]?(?:access[_-]?)?key)?|signature)\s*[:=]\s*\S+)/iu

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
const MAX_ERROR_PATH_PARTS = 16
const MAX_TRAVERSAL_DEPTH = 64

const isProhibitedKey = (key: string) => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "")
  return (
    PROHIBITED_NORMALIZED_KEYS.has(normalized) ||
    PROHIBITED_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  )
}

export class UnsafePersistencePayloadError extends Error {
  constructor(path: readonly (string | number)[]) {
    const boundedPath = path
      .slice(0, MAX_ERROR_PATH_PARTS)
      .map((part) => (typeof part === "number" ? `[${part}]` : "<field>"))
    if (path.length > MAX_ERROR_PATH_PARTS) boundedPath.push("<truncated>")
    super(
      `Unsafe persistence payload at ${boundedPath.length === 0 ? "<root>" : boundedPath.join(".")}`,
    )
    this.name = "UnsafePersistencePayloadError"
  }
}

const includesKnownCredential = (
  value: string,
  knownCredentialValues: readonly string[],
) => {
  if (knownCredentialValues.some((credential) => value.includes(credential))) {
    return true
  }

  try {
    const decoded = decodeURIComponent(value)
    return knownCredentialValues.some((credential) => decoded.includes(credential))
  } catch {
    return false
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
  knownCredentialValues: readonly string[],
): void => {
  if (path.length > MAX_TRAVERSAL_DEPTH) {
    throw new UnsafePersistencePayloadError(path)
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "string") {
      if (
        includesKnownCredential(value, knownCredentialValues) ||
        PROHIBITED_STRING_PATTERN.test(value)
      ) {
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
      visit(item, [...path, index], ancestors, knownCredentialValues)
    }
    ancestors.delete(value)
    return
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new UnsafePersistencePayloadError(path)
  }

  for (const [key, item] of Object.entries(value)) {
    if (
      includesKnownCredential(key, knownCredentialValues) ||
      isProhibitedKey(key)
    ) {
      throw new UnsafePersistencePayloadError([...path, key])
    }
    visit(item, [...path, key], ancestors, knownCredentialValues)
  }
  ancestors.delete(value)
}

/**
 * Rejects non-JSON values and likely secret-bearing keys or URLs.
 *
 * The original payload is never included in the thrown error.
 */
export function assertPersistenceSafe(
  value: unknown,
  knownCredentialValues: readonly string[] = [],
): void {
  visit(value, [], new Set(), knownCredentialValues)
}
