import { createHash } from "node:crypto"

const normalize = (value: unknown): unknown => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON requires finite numbers")
    return value
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (typeof value !== "object") {
    throw new Error("Canonical JSON requires JSON-compatible values")
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Canonical JSON requires plain objects")
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalize(item)]),
  )
}

/** Serializes JSON data with recursively sorted object keys and no whitespace. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(normalize(value))

/** Returns the lowercase SHA-256 digest of canonical JSON data. */
export const canonicalJsonSha256 = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")
