import type { Credentials } from "./types.d.ts";
import { INVALID_IDENTIFIER, INVALID_PATH_SEGMENT } from "./constants.ts";

const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_$][A-Za-z0-9_$/-]*$/;
const CREDENTIALS_VALUES: readonly Credentials[] = [
  "same-origin",
  "include",
  "omit",
];

/**
 * Validates that a string is a safe JavaScript identifier.
 * Used to prevent code injection when interpolating export names into generated client code.
 * @param name - The string to validate
 * @param label - Human-readable label for error messages (e.g. "export name")
 * @returns The validated name if it passes
 * @throws Error if the name contains characters outside /^[A-Za-z_$][A-Za-z0-9_$]*$/
 */
export function validateIdentifier(name: string, label: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(INVALID_IDENTIFIER(label, name));
  }
  return name;
}

/**
 * Validates that a string is a safe path segment for RPC routing.
 * Allows alphanumeric characters, underscores, dollar signs, hyphens, and forward slashes.
 * @param segment - The string to validate
 * @param label - Human-readable label for error messages (e.g. "rpcPrefix")
 * @returns The validated segment if it passes
 * @throws Error if the segment contains disallowed characters
 */
export function validatePathSegment(segment: string, label: string): string {
  if (!SAFE_PATH_SEGMENT.test(segment)) {
    throw new Error(INVALID_PATH_SEGMENT(label, segment));
  }
  return segment;
}

/**
 * Validates and normalizes the credentials option.
 * Accepts "same-origin", "include", or "omit"; defaults to "same-origin" when undefined.
 * @param value - Credentials value to validate
 * @returns The validated credentials string
 * @throws Error if the value is not one of the accepted credentials
 */
export function validateCredentials(value?: string): Credentials {
  const creds = value || "same-origin";
  if (!CREDENTIALS_VALUES.includes(creds as Credentials)) {
    throw new Error(
      `Invalid credentials: "${value}" must be one of ${
        CREDENTIALS_VALUES.join(", ")
      }`,
    );
  }
  return creds as Credentials;
}

/**
 * Validates and normalizes the HTTP method option for a server function.
 * Accepts "GET" or "POST" (case-insensitive); defaults to "POST" when undefined.
 * @param value - Method value to validate
 * @returns The validated uppercase method string
 * @throws Error if the value is not "GET" or "POST"
 */
export function validateMethod(value?: string): "GET" | "POST" {
  const method = (value || "POST").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new Error(`Invalid method: "${value}" must be one of GET, POST`);
  }
  return method;
}
