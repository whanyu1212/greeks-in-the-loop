/**
 * Returns the host's current UTC instant for research response-completion timing.
 *
 * @param now Clock dependency used by tests.
 * @returns Millisecond-precision RFC 3339 timestamp.
 */
export function getTrustedTime(now: () => Date = () => new Date()) {
  return now().toISOString()
}
