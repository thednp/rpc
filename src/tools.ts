/**
 * Escapes special regex metacharacters in a string.
 * Used to safely embed user-configurable values (like rpcPrefix) into regular expressions,
 * preventing ReDoS and regex injection attacks.
 * @param s - The raw string to escape
 * @returns The escaped string safe for use in new RegExp()
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
