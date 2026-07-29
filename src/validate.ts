import type { Credentials } from "./types.d.ts";
import { INVALID_IDENTIFIER, INVALID_PATH_SEGMENT } from "./constants.ts";

const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_$][A-Za-z0-9_$/-]*$/;
const CREDENTIALS_VALUES: readonly Credentials[] = [
  "same-origin",
  "include",
  "omit",
];

export function validateIdentifier(name: string, label: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(INVALID_IDENTIFIER(label, name));
  }
  return name;
}

export function validatePathSegment(segment: string, label: string): string {
  if (!SAFE_PATH_SEGMENT.test(segment)) {
    throw new Error(INVALID_PATH_SEGMENT(label, segment));
  }
  return segment;
}

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
