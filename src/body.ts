/** @module Body-parsing policy and size limiting shared by all five adapters. Exports `bodyKind`, `parseSniffedText`, `parseRawBody`, `preParsedBody`, `readStream`, `assertBodyWithinLimit` — the content-type branching, parsing rules, and byte caps that were previously duplicated in each adapter's `helpers.ts`. It applies `DEFAULT_BODY_LIMIT` from `constants.ts`. Never import this module in client code — it is server-only. */
import type { Readable } from "node:stream";
import { Buffer } from "node:buffer";

import type { BodyResult, JsonValue } from "./types.d.ts";
import { httpError, isClientHttpError } from "./server-helpers.ts";
import {
  DEFAULT_BODY_LIMIT,
  DRAIN_FACTOR,
  PAYLOAD_TOO_LARGE,
} from "./constants.ts";

/**
 * The four parsing branches, decided once.
 *
 * `json` and `text` are not really content types — they mean "declared as JSON"
 * and "nothing we parse structurally", which is why `text` also carries the
 * lenient sniff (see {@link parseSniffedText}).
 */
export type BodyKind = "json" | "multipart" | "urlencoded" | "text";

/**
 * Classifies a raw `Content-Type` header into one of the four parsing branches.
 *
 * The three structural branches are mutually exclusive for any real media type,
 * so the precedence here is arbitrary among them; what matters is that
 * `multipart/form-data` is tested before `json`, since a multipart boundary
 * parameter is attacker-influenced text that can contain the substring "json".
 *
 * This uses substring tests, not exact base-type equality, and that is
 * deliberate: it preserves the long-standing behaviour where a vendor media type
 * like `application/vnd.api+json` is treated as JSON. It does mean this is *not*
 * the same rule as {@link hasContentTypeMismatch}, which compares exact
 * base types. The two disagree only for vendor `+json` types, and reconciling
 * them is a behaviour change rather than a refactor.
 * @param declared - The raw `Content-Type` request header, if present
 * @returns The parsing branch this body belongs to
 */
export const bodyKind = (declared?: string): BodyKind => {
  const type = declared?.toLowerCase() ?? "";
  if (type.includes("multipart/form-data")) return "multipart";
  if (type.includes("urlencoded")) return "urlencoded";
  if (type.includes("json")) return "json";
  return "text";
};

/**
 * The lenient sniff for a body with no usable `Content-Type`.
 *
 * Deliberate, and the reason a `curl` command or the no-JS `<form>` fallback
 * that sends JSON without declaring it still arrives parsed rather than as a
 * string. Contrast with a *declared* JSON body, which is parsed strictly and
 * answers `400` when it does not parse.
 * @param raw - The raw body text
 * @returns The parsed JSON value, or the original string
 */
export const parseSniffedText = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/**
 * Applies the full parsing policy to a raw body string.
 *
 * This is the single implementation of the branching that used to exist five
 * times over. Only a **declared** JSON body is parsed strictly — a malformed one
 * throws {@link httpError} `400` rather than being "recovered" into a
 * `text/plain` string, which used to hand a JSON-declared function a string and
 * answer `200` on malformed input.
 * @param raw - The raw body text
 * @param declared - The raw `Content-Type` request header, if present
 * @returns The normalized body result
 * @throws An `httpError` with status `400` when a declared JSON body does not parse
 */
export const parseRawBody = (raw: string, declared?: string): BodyResult => {
  switch (bodyKind(declared)) {
    case "multipart":
      return { contentType: "multipart/form-data", data: { raw } };
    case "urlencoded":
      // `Object.fromEntries` creates own properties, so a `__proto__` field in
      // the body cannot reach `Object.prototype`.
      return {
        contentType: "application/x-www-form-urlencoded",
        data: Object.fromEntries(new URLSearchParams(raw)),
      };
    case "json": {
      let data: JsonValue;
      try {
        data = JSON.parse(raw) as JsonValue;
      } catch {
        throw httpError(400, "Invalid JSON body");
      }
      return { contentType: "application/json", data };
    }
    default:
      return {
        contentType: "text/plain",
        data: parseSniffedText(raw) as string,
      };
  }
};

/**
 * Applies the same policy to a body the host framework's own parser already
 * decoded, which is the fast path available to Express, Fastify, Koa, and Hono
 * under `@hono/node-server`.
 *
 * Note the two differences from {@link parseRawBody}, both inherent to
 * pre-decoding: multipart data is passed through as-is rather than wrapped in
 * `{ raw }`, and the `text` branch stringifies rather than sniffing, because
 * there is no raw text left to sniff once a parser has claimed the body.
 * @param body - The already-decoded body
 * @param declared - The raw `Content-Type` request header, if present
 * @returns The normalized body result
 */
export const preParsedBody = (body: unknown, declared?: string): BodyResult => {
  switch (bodyKind(declared)) {
    case "multipart":
      return {
        contentType: "multipart/form-data",
        data: body as Record<string, unknown>,
      };
    case "urlencoded":
      return {
        contentType: "application/x-www-form-urlencoded",
        data: body as Record<string, unknown>,
      };
    case "json":
      return { contentType: "application/json", data: body as JsonValue };
    default:
      return { contentType: "text/plain", data: String(body) };
  }
};

/** Options for {@link readStream}. */
export interface ReadStreamOptions {
  /** Maximum bytes to accept. `0` disables the cap. Defaults to {@link DEFAULT_BODY_LIMIT}. */
  limit?: number;
  /** Maximum bytes to discard after the cap is hit before cutting the connection. */
  drainLimit?: number;
}

const capIsActive = (limit: number): boolean =>
  limit > 0 && Number.isFinite(limit);

/**
 * Reads a Node request stream under a byte cap, then applies the shared parsing
 * policy to what was read.
 *
 * **The cap is enforced while streaming, never after buffering.** Chunks are
 * measured as they arrive and nothing past the limit is retained, so an
 * oversized body is never resident in memory — which is the entire point.
 * Buffering first and measuring afterwards, the obvious `readBody`-then-check
 * shape, provides no memory-exhaustion protection at all.
 *
 * Past the cap the remainder is **drained and discarded** rather than the socket
 * being closed on the spot. Closing a socket that still has unread request data
 * makes Node emit `RST`, and the client never learns the real reason it failed.
 * The drain ceiling bounds that discard; past it the connection is cut, so a
 * pathologically large upload sees a reset rather than a `413`, which is normal
 * HTTP behaviour.
 *
 * This is the only place rpc can offer a *real* cap. Where a host framework
 * parses the body itself the host's own limit applies, and where the body is
 * read through a `Request`-style `.text()` (h3, Hono) no chunk callback exists —
 * those paths get {@link assertBodyWithinLimit} instead, which is a
 * `Content-Length` pre-check and therefore advisory.
 * @param source - The Node readable carrying the request body
 * @param declared - The raw `Content-Type` request header, if present
 * @param options - The byte cap and drain ceiling
 * @returns The normalized body result
 * @throws An `httpError` with status `413` when the body exceeds the cap, or `400` when a declared JSON body does not parse
 */
export const readStream = (
  source: Readable,
  declared: string | undefined,
  options: ReadStreamOptions = {},
): Promise<BodyResult> => {
  const limit = options.limit ?? DEFAULT_BODY_LIMIT;
  const drainLimit = options.drainLimit ??
    (capIsActive(limit) ? limit * DRAIN_FACTOR : Infinity);

  return new Promise<BodyResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let drained = 0;
    let tooLarge = false;
    let settled = false;

    const tooLargeError = () => httpError(413, PAYLOAD_TOO_LARGE);

    const finish = (settle: () => void) => {
      // Synchronous-re-entry guard. `finish` detaches the listeners, so the
      // stream cannot normally call back in — but `source.destroy()` in the
      // drain-ceiling branch can emit `error` synchronously on some stream
      // implementations, and a double settle would be an unhandled rejection.
      // Not reachable through the public API, hence the ignore. `ignore next`
      // rather than `ignore else`: this is the body of an `if` with no `else`,
      // so the `else` directive suppresses nothing — and `ignore if` is worse,
      // because it makes istanbul skip the statement after the `if` as well,
      // which does run.
      // istanbul ignore next
      if (settled) return;
      settled = true;
      source.off("data", onData);
      source.off("end", onEnd);
      source.off("error", onError);
      settle();
    };

    const onData = (chunk: Buffer | string) => {
      // Node hands out Buffers, but a stream in string encoding — or a test
      // fixture — yields strings. Normalising here means `Buffer.concat` below
      // is safe and, more importantly, that the cap counts *bytes* rather than
      // UTF-16 code units, which would undercount any multi-byte character.
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      drained += buf.length;
      if (tooLarge) {
        if (drained > drainLimit) {
          // Still pushing long after the verdict — stop reading and let the
          // connection go rather than discard indefinitely.
          finish(() => {
            source.destroy();
            reject(tooLargeError());
          });
        }
        return;
      }
      size += buf.length;
      if (capIsActive(limit) && size > limit) {
        tooLarge = true;
        chunks.length = 0; // release what we hold; the verdict is already decided
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      finish(() => {
        if (tooLarge) {
          reject(tooLargeError());
          return;
        }
        try {
          resolve(parseRawBody(Buffer.concat(chunks).toString(), declared));
        } catch (err) {
          reject(err);
        }
      });
    };

    const onError = (err: Error) => finish(() => reject(err));

    source.on("data", onData);
    source.on("end", onEnd);
    source.on("error", onError);
  });
};

/**
 * Rejects a request whose declared `Content-Length` exceeds the cap, before any
 * body is read.
 *
 * This is the **advisory** half of the limit, for the two adapters that read the
 * body through a `Request`-style `.text()` (h3 and Hono) and so have no chunk
 * callback to measure against, and for any path where rejecting before reading
 * is simply cheaper.
 *
 * It is advisory because `Content-Length` is a client-supplied hint: a chunked
 * request has none, and a lying one is easy to send. A real cap for those
 * runtimes comes from the framework's own body-limit middleware — h3's
 * `assertBodySize` / `hono/body-limit` — and the wiki documents this per
 * adapter. Do not present this as equivalent to {@link readStream}.
 * @param contentLength - The raw `Content-Length` header, if present
 * @param limit - The byte cap; `0` disables the check
 * @throws An `httpError` with status `413` when the declared length exceeds the cap
 */
export const assertBodyWithinLimit = (
  contentLength: string | undefined | null,
  limit: number,
): void => {
  if (!capIsActive(limit) || !contentLength) return;
  const declared = Number(contentLength);
  // Absent, non-numeric, or negative Content-Length is not a usable signal, and
  // chunked encoding legitimately has none.
  if (!Number.isFinite(declared) || declared < 0) return;
  if (declared > limit) throw httpError(413, PAYLOAD_TOO_LARGE);
};

/**
 * The slice of a Web-standard `Request` that {@link readWebBody} needs.
 *
 * Structural rather than a concrete `Request`, so both h3's `event.req` and
 * Hono's `c.req.raw` satisfy it and neither framework type has to be imported
 * into this module.
 */
export interface WebBodySource {
  /** The request body stream, or `null` when there is none. */
  body: ReadableStream<Uint8Array> | null;
  /** Whether something has already consumed the body. */
  bodyUsed: boolean;
  /** Fallback reader for an already-consumed body. */
  text: () => Promise<string>;
}

/**
 * Reads a Web-standard `Request` body under a byte cap, then applies the shared
 * parsing policy.
 *
 * This exists because a `Content-Length` pre-check is close to worthless on these
 * runtimes, and that was measured rather than assumed. A `Request` constructed in
 * JavaScript — which is how a request arrives under `app.fetch()`, and on
 * Workers, Bun, Deno, and most serverless adapters — does **not** carry a
 * `Content-Length` header; that is added by the HTTP layer when serialising, and
 * it is absent entirely for a chunked request. A 12 MB body against a 1 MiB
 * `bodyLimit` returned `200` through the pre-check alone.
 *
 * So the cap is enforced against the bytes as they arrive, from the same
 * `ReadableStream` the framework would have read. Nothing past the limit is
 * retained, and the reader is cancelled at the verdict so the upload stops
 * rather than being drained forever.
 *
 * If the body has already been consumed by a framework body-limit middleware,
 * `bodyUsed` is true and there is nothing left to measure, so this defers to
 * `text()` and that middleware's limit is the operative one.
 * @param request - The request whose body should be read
 * @param declared - The raw `Content-Type` request header, if present
 * @param options - The byte cap
 * @returns The normalized body result
 * @throws An `httpError` with status `413` when the body exceeds the cap, or `400` when a declared JSON body does not parse
 */
export const readWebBody = async (
  request: WebBodySource,
  declared: string | undefined,
  options: ReadStreamOptions = {},
): Promise<BodyResult> => {
  const limit = options.limit ?? DEFAULT_BODY_LIMIT;

  if (!request.body || request.bodyUsed) {
    return parseRawBody(await request.text(), declared);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // The Streams spec pairs `done: false` with a chunk, so this is defensive
      // rather than reachable; skipping a stray empty read is cheaper than
      // letting it throw. `ignore if` rather than `ignore else` — again an `if`
      // body with no `else`, so the `else` directive suppresses nothing.
      // istanbul ignore if
      if (!value) continue;
      size += value.byteLength;
      if (capIsActive(limit) && size > limit) {
        // Release what we hold and stop the upload. There is no "drain then
        // answer" dance here as there is for a Node stream: cancelling the
        // reader is the whole teardown.
        chunks.length = 0;
        await reader.cancel();
        throw httpError(413, PAYLOAD_TOO_LARGE);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (isClientHttpError(err)) throw err;
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }

  return parseRawBody(Buffer.concat(chunks).toString(), declared);
};
