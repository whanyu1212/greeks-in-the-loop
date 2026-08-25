const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u

const NANOSECONDS_PER_MILLISECOND = 1_000_000n

/**
 * Parses a decimal provider value into an exact number of cents.
 *
 * @param value Decimal value represented as a JSON number or string.
 * @returns Exact integer cents, or `undefined` when the value has unsupported
 *     precision or cannot be represented safely.
 */
export function parseExactCents(value: unknown): number | undefined {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : undefined
  if (text === undefined) return undefined

  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/u.exec(text)
  if (match === null) return undefined

  const [, sign = "", whole, fraction = ""] = match
  if (whole === undefined) return undefined

  const unsignedCents =
    BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))
  const cents = sign === "-" ? -unsignedCents : unsignedCents
  if (
    cents > BigInt(Number.MAX_SAFE_INTEGER) ||
    cents < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    return undefined
  }
  return Number(cents)
}

/**
 * Parses an RFC 3339 instant without truncating fractional seconds.
 *
 * @param value Timestamp with a UTC designator or numeric offset.
 * @returns Epoch nanoseconds, or `undefined` for malformed or unsupported input.
 */
export function parseRfc3339Nanoseconds(value: string): bigint | undefined {
  const match = RFC3339_PATTERN.exec(value)
  if (match === null) return undefined

  const [, year, month, day, hour, minute, second, fraction = "", offset] = match
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    offset === undefined
  ) {
    return undefined
  }

  const numericParts = [year, month, day, hour, minute, second].map(Number)
  const [
    numericYear,
    numericMonth,
    numericDay,
    numericHour,
    numericMinute,
    numericSecond,
  ] = numericParts
  if (
    numericYear === undefined ||
    numericMonth === undefined ||
    numericDay === undefined ||
    numericHour === undefined ||
    numericMinute === undefined ||
    numericSecond === undefined
  ) {
    return undefined
  }

  // Date.parse may normalize impossible dates. Validate the local calendar
  // components independently before applying the RFC 3339 offset.
  const localCalendar = new Date(
    Date.UTC(
      numericYear,
      numericMonth - 1,
      numericDay,
      numericHour,
      numericMinute,
      numericSecond,
    ),
  )
  if (
    localCalendar.getUTCFullYear() !== numericYear ||
    localCalendar.getUTCMonth() !== numericMonth - 1 ||
    localCalendar.getUTCDate() !== numericDay ||
    localCalendar.getUTCHours() !== numericHour ||
    localCalendar.getUTCMinutes() !== numericMinute ||
    localCalendar.getUTCSeconds() !== numericSecond
  ) {
    return undefined
  }

  const wholeSecond = `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`
  const epochMilliseconds = Date.parse(wholeSecond)
  if (!Number.isFinite(epochMilliseconds)) return undefined

  const nanoseconds = BigInt(fraction.padEnd(9, "0"))
  return BigInt(epochMilliseconds) * NANOSECONDS_PER_MILLISECOND + nanoseconds
}

/**
 * Floors an epoch-nanosecond instant to a canonical millisecond timestamp.
 *
 * @param epochNanoseconds Instant represented in nanoseconds since Unix epoch.
 * @returns ISO timestamp with exactly millisecond precision.
 */
export function floorNanosecondsToIsoMilliseconds(
  epochNanoseconds: bigint,
): string {
  const quotient = epochNanoseconds / NANOSECONDS_PER_MILLISECOND
  const remainder = epochNanoseconds % NANOSECONDS_PER_MILLISECOND
  const epochMilliseconds =
    epochNanoseconds < 0n && remainder !== 0n ? quotient - 1n : quotient
  return new Date(Number(epochMilliseconds)).toISOString()
}
