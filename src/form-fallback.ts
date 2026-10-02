/**
 * @module The pieces of the no-JS form fallback that are mechanism rather than
 * application knowledge: detecting a native form navigation, and making a
 * redirect target safe.
 *
 * Both are exported so that a framework built on rpc — or anyone composing the
 * fallback by hand — uses the same rules instead of re-deriving them. That is
 * not hypothetical: the cross-origin gap this module exists alongside came from
 * every project writing its own fallback and none of them reading the request's
 * `Origin`.
 *
 * Server-only. Never import from client code.
 */

import { bodyKind } from "./body.ts";
import { encodeFormFlash, FLASH_PARAM } from "./form-flash.ts";
import type { FormFlash } from "./form-flash.ts";
// The codec is client-safe and lives in its own module so a browser can read a
// flash too. Re-exported here so every existing `@thednp/rpc/server` import keeps
// resolving, and imported because this module uses all of it below.
export {
  decodeFormFlash,
  encodeFormFlash,
  FLASH_LIMIT,
  FLASH_PARAM,
} from "./form-flash.ts";
export type { FormFlash } from "./form-flash.ts";
import { isRPCError } from "./server-helpers.ts";
import type {
  FormFallbackOptions,
  FormFallbackOutcome,
  ValidationIssue,
} from "./types.d.ts";

/**
 * The subset of a request the navigation test needs.
 *
 * Structural rather than a framework type, so an Express `req`, a Hono context,
 * a Web `Request` and any other host's shape all satisfy it by passing the five
 * fields.
 */
export interface FormNavigationRequest {
  /** HTTP method. Compared case-insensitively. */
  readonly method?: string | undefined;
  /** Raw `Content-Type` request header, if present. */
  readonly contentType?: string | undefined;
  /** Raw `Accept` request header, if present. */
  readonly accept?: string | undefined;
  /**
   * Raw `Sec-Fetch-Dest`, when the client sends fetch metadata.
   *
   * Optional because not every client sends it — `curl` does not, and neither
   * does a browser predating fetch metadata. Where it *is* present it is a much
   * better navigation signal than `Accept` alone.
   */
  readonly secFetchDest?: string | undefined;
  /** Raw `Sec-Fetch-Mode`, when the client sends fetch metadata. */
  readonly secFetchMode?: string | undefined;
}

/**
 * Whether a request is a native form submission rather than an RPC call.
 *
 * **The discriminator is the navigation, not the content type.** A form-declared
 * function is called by two different clients that both send a form content
 * type: a native `<form>` posts `application/x-www-form-urlencoded`, and the
 * generated client stub posts `multipart/form-data` via `fetch`. Keying on
 * content type alone cannot tell them apart, and a fallback that did would hand
 * every browser-side caller a `303` where it expected a rejection — breaking
 * `data` promise rejection, `fieldErrors`, and the stub's error handling for any
 * form-declared function.
 *
 * So the rule is: `POST`, plus a form content type — which keeps an
 * `Accept: text/html` fetch out of the form path — and then, where fetch
 * metadata is present, `Sec-Fetch-Dest`/`Sec-Fetch-Mode` decide: a navigation is
 * a document request and a `fetch` is not, whatever `Accept` claims. Only when
 * both metadata headers are absent does `Accept` decide, by requiring
 * `text/html`. A browser navigation sends `text/html`; `fetch` does not by
 * default, and its wildcard `Accept` is not enough.
 *
 * Unlike the reference implementation in `bart-js`, `multipart/form-data` *is*
 * accepted here, because a native `<form enctype="multipart/form-data">` is a
 * real navigation and the file-upload case is the reason that content type
 * exists. The navigation gate is what keeps `fetch` out, and it does not depend
 * on which form encoding arrived.
 *
 * @param request - Method, raw content-type/accept headers, and optional fetch-metadata headers
 * @returns `true` when this is a native form submission
 */
export const isNativeFormNavigation = (
  request: FormNavigationRequest,
): boolean => {
  if (request.method?.toUpperCase() !== "POST") return false;
  // **Which signal decides.** Fetch metadata, where it is present, is more
  // reliable than `Accept`: a navigation is a document request and a `fetch` is
  // not, whatever `Accept` happens to claim. TanStack Start and SolidStart both
  // discriminate on these headers for the same reason. So when either is present
  // they decide; only when both are absent does `Accept` — the one header every
  // client sends — get the vote. An absent header within a present pair is not
  // treated as disagreement, so a partially-supporting client is not excluded
  // twice over.
  if (
    request.secFetchDest !== undefined || request.secFetchMode !== undefined
  ) {
    const dest = request.secFetchDest?.toLowerCase();
    const mode = request.secFetchMode?.toLowerCase();
    const navigational = (dest === undefined || dest === "document") &&
      (mode === undefined || mode === "navigate");
    if (!navigational) return false;
  } else if (!request.accept?.toLowerCase().includes("text/html")) {
    return false;
  }
  // Reuse the adapters' own classifier rather than a parallel check, so the two
  // form encodings are recognised identically everywhere. `bodyKind` also copes
  // with parameters, which a `multipart/form-data; boundary=…` header carries.
  const kind = bodyKind(request.contentType);
  return kind === "multipart" || kind === "urlencoded";
};

/**
 * The fallback used whenever a redirect target cannot be trusted.
 *
 * A root-relative path rather than a bare `/`, so it is always unambiguous.
 */
const REDIRECT_FALLBACK = "/";

/**
/**
 * Whether a string contains a C0 control character or DEL.
 *
 * Written as an explicit codepoint scan rather than a regex with a control-
 * character class, so the intent is visible without a lint suppression, and so
 * the rule is the same one a reader would write.
 *
 * @param value - The string to scan
 * @returns `true` when any character is a control character
 */
const hasControlCharacter = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
};

/**
 * Makes a redirect target safe to send a browser to.
 *
 * Post/Redirect/Get needs somewhere to go, and the two obvious sources are both
 * attacker-influenceable: a hidden `__redirect` field, which whoever renders the
 * form chooses, and the `Referer` header, which is stripped from native form
 * POSTs often enough that projects reach for it anyway. Redirecting to either
 * unchecked is an open redirect — `//evil.test` and `javascript:` being the
 * payloads that matter.
 *
 * The policy is an **allowlist of shape**, not a denylist of schemes: a target
 * must be an absolute, root-relative path, which rejects `javascript:`,
 * `data:`, `vbscript:`, protocol-relative `//host` and absolute `http://host` in
 * one step. Denylists lose to obfuscation (`java&#9;script:`) more often than an
 * allowlist loses to a missing case, so the scheme is never parsed as a scheme.
 * The origin check afterwards is then belt-and-braces rather than the defence.
 *
 * The fragment is preserved — it never reaches the server, and dropping it loses
 * the scroll position the author was aiming at. The query is preserved because it
 * is where a flash payload rides.
 *
 * @param target - The raw redirect target, from wherever the caller obtained it
 * @param base - The absolute URL of the current request, used to resolve and to
 *   compare origins
 * @returns A same-origin path, or `/` when the target cannot be trusted
 */
export const sanitizeRedirect = (
  target: string | null | undefined,
  base: string,
): string => {
  if (typeof target !== "string") return REDIRECT_FALLBACK;
  const trimmed = target.trim();
  if (!trimmed) return REDIRECT_FALLBACK;
  // Control characters can smuggle a scheme past a naive prefix test; a newline
  // in a `Location` header is a response-splitting primitive.
  if (hasControlCharacter(trimmed)) return REDIRECT_FALLBACK;
  // Must be an absolute, root-relative path. This is what rejects `javascript:`,
  // `data:`, `//evil.test` and `http://evil.test` alike.
  if (!trimmed.startsWith("/")) return REDIRECT_FALLBACK;
  // A backslash is normalised to `/` by the URL parser, so `/\evil.test` is a
  // protocol-relative reference to another host.
  if (trimmed.includes("\\")) return REDIRECT_FALLBACK;
  try {
    const baseUrl = new URL(base);
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.origin !== baseUrl.origin) return REDIRECT_FALLBACK;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    // An unparseable base means we cannot establish an origin, so we cannot
    // vouch for the target either.
    return REDIRECT_FALLBACK;
  }
};

/**
 * The outcome of a native form submission, as carried in the redirect URL.
 *
 * **This is the contract, and rpc owns it.** The outcome is not a new return
 * type: it is derived from what already happened, which is what keeps the whole
 * feature from touching the library's most load-bearing typing.
 *
 * | what the handler did | outcome |
 * | --- | --- |
 * | returned normally | success; the declared redirect target, no flash |
 * | threw an `RPCError` (or a typed subclass) | failure; `message` from its `hint`, `errors` from `ValidationError.issues` |
 * | threw anything else | **not a flash** — a genuine `500`, because an unexpected error must not be laundered into a friendly redirect, and must not put its message in a URL |
 *
 * Reusing the error model rather than introducing a parallel result union is the
 * whole reason this composes with what already ships: `schema` failures,
 * `NotFoundError`, and hand-thrown `RPCError`s all already carry the two things a
 * form needs — author-written advice and per-field issues.
 */

/**
 * A {@link FormFallbackOptions} reduced to one shape, so the dispatch reads one
 * thing instead of re-deriving sugar at request time.
 */
export interface ResolvedFallback {
  readonly to: string | ((outcome: FormFallbackOutcome) => string);
  /**
   * Always present, and empty unless the author named fields — the default is
   * replay nothing.
   */
  readonly replay: readonly string[];
}

/**
 * Normalises the authored `fallback` option: `undefined` stays `undefined`, a
 * bare string is shorthand for "this path, replay nothing", and an object is
 * taken apart.
 *
 * The `replay` array is **copied and frozen**. It is consulted at dispatch time,
 * on every request, from the author's object — so without the copy a caller that
 * pushed to the array after registration would silently change the replay policy
 * of a function that is already serving traffic. Freezing the copy also makes an
 * accidental later write fail loudly instead of being ignored.
 */
export function resolveFallback(
  fallback: string | FormFallbackOptions | undefined,
): ResolvedFallback | undefined {
  if (fallback === undefined) return undefined;
  if (typeof fallback === "string") {
    return { to: fallback, replay: Object.freeze([]) };
  }
  const { to, replay } = fallback;
  if (typeof to !== "string" && typeof to !== "function") {
    throw new TypeError(
      "rpc: `fallback.to` must be a string path or a function returning one.",
    );
  }
  return {
    to,
    replay: replay === undefined
      ? Object.freeze([])
      : Object.freeze([...replay]),
  };
}

/**
 * Reduces a thrown value to a flash, or `null` when it must not become one.
 *
 * `null` for anything that is not an `RPCError`, and that is the important case:
 * an unexpected exception is a server fault and stays a `500`. Flashifying one
 * would both hide it and write its message into a URL, which is the opposite of
 * what an author wants when something genuinely broke.
 *
 * Cross-bundle safe: the test is {@link isRPCError}'s registered-symbol brand,
 * not `instanceof`, because each tsdown entry carries its own copy of the class.
 *
 * @param err - The value the handler threw
 * @returns A flash, or `null` when the value must not be redirected past
 */
export const flashFromError = (err: unknown): FormFlash | null => {
  if (!isRPCError(err)) return null;
  const flash: {
    errors?: Record<string, string[]>;
    message?: string;
  } = {};
  // Only `ValidationError` carries `issues`, and its presence is what makes a
  // failure per-field rather than general.
  const issues = (err as { issues?: readonly ValidationIssue[] }).issues;
  if (issues && issues.length > 0) {
    const grouped: Record<string, string[]> = {};
    for (const issue of issues) {
      const text = issue.message ?? issue.hint;
      if (text === undefined) continue;
      (grouped[issue.path ?? ""] ??= []).push(text);
    }
    flash.errors = grouped;
  }
  // A `hint` is author-written and was meant to be read; `message` is a
  // fallback, so a generic thrown error still says something useful.
  flash.message = err.hint ?? err.message;
  return flash;
};

/**
 * Selects the submitted fields that may be replayed into the redirect URL.
 *
 * An explicit allowlist, defaulting to nothing. "Replay everything except the
 * obvious secrets" is not implementable — rpc cannot know which of your fields
 * are tokens, and a field named `note` is as likely to be one as a field named
 * `password`. Naming the fields is a sentence the author has to write, which is
 * the point.
 *
 * @param fields - The submitted fields
 * @param allowed - Field names permitted in the redirect URL; empty means none
 * @returns Only the permitted fields, and only ones that are primitive
 */
export const pickReplayable = (
  fields: unknown,
  allowed: readonly string[] = [],
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  // The submitted body is whatever the client sent, so it reaches here as
  // `unknown`. A primitive or `null` has no own keys to read, which is not an
  // error — it just means nothing is replayable.
  if (fields === null || typeof fields !== "object") return out;
  const record = fields as Record<string, unknown>;
  for (const key of allowed) {
    const value = record[key];
    // Primitives only: a nested object would serialise to `[object Object]` and
    // a `File` would serialise to an empty string, both of which would look like
    // data the author chose to replay.
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    }
  }
  return out;
};

/**
 * Builds the Post/Redirect/Get target for a failed native form submission.
 *
 * The target is sanitized, so a caller that passes a field-controlled value
 * cannot turn this into an open redirect. A flash that will not fit is dropped
 * rather than truncated — see {@link FLASH_LIMIT}.
 *
 * @param target - Where to send the browser; treated as untrusted
 * @param flash - The outcome to carry, or `null` to redirect without one
 * @param base - Absolute resolution base, defaulting to the inert localhost origin. A request URL is not needed because the emitted target is same-origin `pathname + search`.
 * @returns A same-origin URL, safe to put in a `Location` header
 */
export const flashRedirectUrl = (
  target: string,
  flash: FormFlash | null,
  base: string,
): string => {
  const safe = sanitizeRedirect(target, base);
  if (!flash) return safe;
  const encoded = encodeFormFlash(flash);
  if (encoded === null) return safe;
  const url = new URL(safe, base);
  url.searchParams.set(FLASH_PARAM, encoded);
  return `${url.pathname}${url.search}`;
};

/**
 * An inert origin used to resolve a root-relative redirect target.
 *
 * `sanitizeRedirect` needs an absolute base to resolve against, and compares
 * origins to reject protocol-relative targets like `//evil.test`. The host in
 * that base is therefore *only* ever used as a comparison key: results are
 * emitted as `pathname + search + hash`, so it can never appear in a
 * `Location`.
 *
 * A constant is better than the request's own host here. `Host` is
 * attacker-influenceable, and feeding it into a redirect decision would make the
 * safety of the result depend on a header the caller controls — while buying
 * nothing, since every target is required to be root-relative.
 */
const REDIRECT_BASE = "http://localhost/";

/**
 * The `Location` for a native form submission that **failed**, or `undefined`
 * when this request is not one.
 *
 * `undefined` is the important return, and it covers four distinct reasons, each
 * of which must fall through to the adapter's normal handling rather than being
 * redirected:
 *
 * - the function has no `fallback` configured — the feature is opt-in;
 * - the request is not a native form navigation — including every `fetch` from
 *   the generated stub, which must keep getting its JSON;
 * - the error is not client-facing, so it is a genuine fault and stays a `500`.
 *   A stack trace must never be laundered into a friendly redirect;
 * - the author's `to` threw or returned a non-string.
 *
 * A target that is merely *unsafe* is not in this list: it still redirects, to
 * the sanitiser's same-origin fallback. See {@link redirectFor}.
 *
 * Adapters call this **ahead of** their client-error branch. That is the whole
 * point of it living here rather than at the validation call site: a
 * `ValidationError` is a *client-facing* error, so the branch that renders it as
 * a `422` JSON body would otherwise claim it first, and a rejected submission —
 * the case the entire feature exists for — would reach the browser as raw JSON.
 */
export const formFallbackLocation = (
  err: unknown,
  fallback: string | FormFallbackOptions | undefined,
  submitted: unknown,
  request: FormNavigationRequest,
  base: string = REDIRECT_BASE,
): string | undefined => {
  const resolved = resolveFallback(fallback);
  if (!resolved) return undefined;
  if (!isNativeFormNavigation(request)) return undefined;
  const flash = flashFromError(err);
  // Not a client-facing error: a real fault. Let it be a 500.
  if (!flash) return undefined;
  return redirectFor(resolved, { status: "error", ...flash }, submitted, base);
};

/**
 * The `Location` for a native form submission that **succeeded**, or
 * `undefined` when this request is not one.
 *
 * Success carries no flash — there is no failure to report — so the redirect is
 * just the author's target. `replay` still applies, because an author who wants
 * to show what was submitted ("we emailed bob@example.com") can name it, and
 * naming is the whole consent mechanism.
 */
export const formSuccessLocation = (
  fallback: string | FormFallbackOptions | undefined,
  submitted: unknown,
  request: FormNavigationRequest,
  base: string = REDIRECT_BASE,
): string | undefined => {
  const resolved = resolveFallback(fallback);
  if (!resolved) return undefined;
  if (!isNativeFormNavigation(request)) return undefined;
  return redirectFor(resolved, { status: "ok" }, submitted, base);
};

/** Shared tail: pick the target, attach the replayed values, make it safe. */
const redirectFor = (
  resolved: ResolvedFallback,
  outcome: FormFallbackOutcome,
  submitted: unknown,
  base: string,
): string | undefined => {
  let target: string;
  try {
    target = typeof resolved.to === "function"
      ? resolved.to(outcome)
      : resolved.to;
  } catch {
    // An author's chooser that throws must not become a 500 with a stack trace
    // in the URL. Treat it as "no target" and fall through to normal handling.
    return undefined;
  }
  if (typeof target !== "string") return undefined;
  const replayed = pickReplayable(submitted, resolved.replay);
  // `pickReplayable` returns an empty object rather than null when nothing was
  // allowed, and `{}` is truthy — so key count, not existence, is what decides
  // whether there is anything to replay.
  const hasValues = Object.keys(replayed).length > 0;
  const flash: FormFlash = hasValues
    ? { ...outcome, values: replayed }
    : { ...outcome };
  // Nothing to say: a success with nothing replayed carries no failure and no
  // values, so emitting `?__flash={"status":"ok"}` would be pure noise in the
  // URL — and a parameter the re-rendered page has to learn to ignore. `null`
  // makes `flashRedirectUrl` emit the bare target.
  const hasContent = flash.errors !== undefined ||
    flash.message !== undefined ||
    hasValues;
  const payload = hasContent ? flash : null;
  // An unsafe target is not an error: `sanitizeRedirect` substitutes its own
  // same-origin fallback, so a `//evil.test` from a mis-written `to` still lands
  // the user on a real page with the flash intact. Falling through to the JSON
  // error instead would serve the no-JS user raw JSON — the exact outcome this
  // feature exists to prevent — in exchange for hiding an author bug.
  return flashRedirectUrl(target, payload, base);
};
