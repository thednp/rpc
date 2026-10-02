/**
 * Shared contact-form logic used by the RPC server function, the demo
 * renderer, and the client-side hydrate.
 * Everything here is pure and framework-agnostic so all three callers
 * validate with the exact same schema and build identical issue URLs.
 */
import { FLASH_PARAM, decodeFormFlash } from "@thednp/rpc/flash";
import * as v from "valibot";

/** Field names the contact form submits, in display order. */
export const CONTACT_FIELDS = ["name", "email", "topic", "title", "message"] as const;

/** Static per-field error messages shown when a nojs submission fails. */
export const CONTACT_ERROR_MESSAGES: Record<string, string> = {
  name: "Please tell us your name.",
  email: "That email doesn't look right.",
  topic: "Pick a topic.",
  title: "Please add a title.",
  message: "Give us a bit more detail (10+ characters).",
};

/** Shared valibot schema — the single source of truth for contact validation. */
export const ContactSchema = v.object({
  name: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(2, "Please tell us your name."),
    v.maxLength(60, "Keep it under 60 characters."),
  ),
  email: v.pipe(
    v.string(),
    v.trim(),
    v.email("That email doesn't look right."),
  ),
  topic: v.pipe(
    v.optional(v.string(), ""),
    v.trim(),
    v.minLength(1, "Pick a topic."),
  ),
  title: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, "Please add a title."),
  ),
  message: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(10, "Give us a bit more detail (10+ characters)."),
    v.maxLength(2000, "Keep it under 2000 characters."),
  ),
});

/**
 * The validated shape the server function's handler receives.
 *
 * Derived from {@link ContactSchema} rather than written out, so the two cannot
 * drift: `schema` transforms before the handler is entered, which is what makes
 * the trimmed values available here without a cast.
 */
export type ContactOutput = v.InferOutput<typeof ContactSchema>;

/** Result of a contact form validation attempt. */
export type ContactValidation =
  | { ok: true; output: Record<string, string> }
  | { ok: false; errors: Partial<Record<string, string[]>> };

/**
 * Validates a flat field record against the shared schema.
 * Mirrors the shape produced by `v.flatten` so direct uses and rendered
 * recovery state share the same field-level error object.
 */
export const validateContactForm = (
  fields: Record<string, string>,
): ContactValidation => {
  const result = v.safeParse(ContactSchema, fields);
  if (result.issues) {
    return { ok: false, errors: v.flatten(result.issues).nested ?? {} };
  }
  return { ok: true, output: result.output as Record<string, string> };
};

/**
 * Builds the GitHub "new issue/discussion" URL from submitted fields.
 * `ghLogin` (e.g. "@login") is injected when a matching GitHub user is found.
 */
export const buildIssueUrl = (
  fields: Record<string, string>,
  ghLogin = "",
): string => {
  const topic = fields.topic ?? "";
  const issueTitle = fields.title ?? "";
  const message = fields.message ?? "";

  if (topic === "Bug report") {
    const params = new URLSearchParams({
      template: "bug_report.yml",
      title: issueTitle,
      description: [
        message,
        "",
        ghLogin
          ? `Reported by ${ghLogin} via the [@thednp/rpc demo](https://thednp.github.io/rpc/).`
          : "*Submitted from the [@thednp/rpc demo](https://thednp.github.io/rpc/).*",
      ].join("\n"),
    });
    // post a new issue/bug
    return `https://github.com/thednp/rpc/issues/new?${params.toString()}`;
  }

  const title = `[${topic}] ${issueTitle}`;
  const body = [
    "*Submitted from the [@thednp/rpc demo](https://thednp.github.io/rpc/).*",
    ghLogin ? `Reported by ${ghLogin}.` : "",
    "",
    "**Message:**",
    message,
  ]
    .filter(Boolean)
    .join("\n");
  const params = new URLSearchParams({ title, body });
  // start a new discussion
  return `https://github.com/thednp/rpc/discussions/new?category=general&${params.toString()}`;
};

/** Parsed form state recovered from a `__flash` query parameter. */
export type FormState = {
  values: Partial<Record<(typeof CONTACT_FIELDS)[number], string>>;
  errors: string[];
};

/**
 * Parses form recovery state out of a search/query string. Only known field
 * names are kept (whitelist) and error messages come from the static map —
 * never from the URL — so crafted query strings cannot inject markup.
 */
export const parseFormState = (query: string): FormState => {
  const params = new URLSearchParams(query);
  // The failure travels in a single `__flash` parameter written by the built-in
  // fallback, decoded with the client-safe codec so this works in the browser as
  // well as during SSR.
  const flash = decodeFormFlash(params.get(FLASH_PARAM));
  const values: FormState["values"] = {};
  if (flash?.values) {
    // Whitelisted against the known fields even though rpc already allowlisted
    // them: these values arrived in a URL, so they are still untrusted input, and
    // this is where a crafted link would be caught.
    for (const field of CONTACT_FIELDS) {
      const value = flash.values[field];
      if (typeof value === "string" && value) values[field] = value;
    }
  }
  const errors = flash?.errors
    ? Object.keys(flash.errors).filter((field) =>
      CONTACT_FIELDS.includes(field as never)
    )
    : [];
  return { values, errors };
};


/** Escapes a string for safe injection into SSR HTML. */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
