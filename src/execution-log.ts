/**
 * @module Execution context: the bounded, redacted record of one dispatch.
 *
 * The library emits a `DispatchContext` and retains **nothing** — no buffer, no
 * TTL, no ring. A host that wants to keep records passes them to its own
 * storage through the `onDispatch` middleware option.
 *
 * That inversion is the whole design. A library-owned ring buffer would mean rpc
 * holding request data in memory for every consumer, whether or not they wanted
 * it, and args routinely contain passwords. A hook makes retention opt-in and
 * keeps the redaction policy with the app that has to answer for it.
 *
 * There is deliberately no `createExecutionLog()` here. An earlier draft had
 * one — a bounded ring with a TTL — and it was cut: a library-owned buffer means
 * rpc holding request data in memory for every consumer, whether or not they
 * asked, which is the exact risk the hook exists to avoid.
 * @module
 */
import type {
  DispatchContext,
  DispatchErrorRecord,
  DispatchOutcome,
  EmitDispatch,
  OnDispatch,
} from "./types.d.ts";
import { isRPCError, type OriginTier } from "./server-helpers.ts";

/** Bounds the shape renderer, so a pathological input cannot produce a huge string. */
const MAX_DEPTH = 3;
/** Keys described per object before the rest are summarised. */
const MAX_KEYS = 8;

/**
 * Describes a value's **shape** without revealing it.
 *
 * Args cross this boundary on every dispatch and routinely contain passwords,
 * API keys and personal data, so the default is to record only what kind of
 * thing arrived — enough to answer "was this an object or a bare string?" and
 * "which fields were present?", which is what a mismatch actually looks like.
 *
 * Bounded in depth and key count, and cycle-safe: a caller cannot make this
 * allocate without bound.
 */
export const argShape = (
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
): string => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "bigint") return "bigint";
  if (typeof value === "function") return "function";
  if (typeof value === "symbol") return "symbol";
  if (Array.isArray(value)) {
    // A self-referential array would otherwise recurse through `map` forever.
    if (seen.has(value)) return "circular";
    seen.add(value);
    // The element shapes, deduplicated: `[1,1,1]` and `["a","a"]` differ in a
    // way that matters, and a long list of the same shape does not.
    const shapes = [
      ...new Set(value.map((item) => argShape(item, depth + 1, seen))),
    ];
    seen.delete(value);
    return `array[${shapes.join("|")}]`;
  }
  // Past the `typeof` chain and the array arm, `value` is a non-null object —
  // so no further type guard is needed, and adding one only creates an arm that
  // can never be taken.
  if (seen.has(value)) return "circular";
  seen.add(value);
  if (depth >= MAX_DEPTH) return "object(…)";
  const entries = Object.entries(value as Record<string, unknown>);
  const described = entries.slice(0, MAX_KEYS).map(([key, item]) =>
    `${key}:${argShape(item, depth + 1, seen)}`
  );
  const extra = entries.length - described.length;
  if (extra > 0) described.push(`+${extra} more`);
  // Scoped to the current path, not the whole object graph: a value reachable
  // twice by sibling keys is a DAG, not a cycle, and is described both times.
  seen.delete(value);
  return `{${described.join(",")}}`;
};

/** Describes the argument list of a dispatch. */
export const argsShape = (args: readonly unknown[]): string =>
  `[${args.map((arg) => argShape(arg)).join(",")}]`;

/**
 * Describes a caught error for a record, under the caller's redaction policy.
 *
 * `includeMessages` and `includeStacks` are the two switches that decide
 * whether the record can quote the failure or only classify it.
 */
export const describeError = (
  err: unknown,
  opts: { includeMessages?: boolean; includeStacks?: boolean } = {},
): DispatchErrorRecord => {
  const rpcError = isRPCError(err);
  const anyErr = err as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
    code?: unknown;
  };
  const record: DispatchErrorRecord = {
    name: typeof anyErr?.name === "string" ? anyErr.name : "Error",
    isRPCError: rpcError,
  };
  if (rpcError) record.code = String(anyErr.code ?? "INTERNAL");
  if (opts.includeMessages && typeof anyErr?.message === "string") {
    record.message = anyErr.message;
  }
  if (opts.includeStacks && typeof anyErr?.stack === "string") {
    record.stack = anyErr.stack;
  }
  return record;
};

/**
 * Mints a correlation id. `crypto.randomUUID` is global from Node 19 and in
 * every edge runtime; it is truncated to 16 hex characters because the id goes
 * in a header and a log line, not in something a human has to read.
 */
export const newDispatchId = (): string =>
  globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);

/** Derives the outcome from a status, so the two cannot disagree. */
export const outcomeForStatus = (status: number): DispatchOutcome =>
  status >= 500 ? "server-error" : status >= 400 ? "client-error" : "ok";

/**
 * Builds the emitter an adapter calls at the end of a dispatch.
 *
 * With no `onDispatch` this returns `undefined` and the adapter skips the whole
 * thing — which is also why the correlation id appears on failure responses
 * *only* when a hook is registered: with nobody collecting, a new field in the
 * error body would be a change to the wire contract for no benefit.
 *
 * A throwing hook is swallowed. A logging facility that takes down the request
 * it is describing would be a strictly worse system than one that loses a
 * record.
 */
export const createDispatcher = (
  onDispatch?: OnDispatch,
): EmitDispatch | undefined => {
  if (!onDispatch) return undefined;
  const includeMessages = process.env.NODE_ENV !== "production";
  const includeStacks = process.env.NODE_ENV !== "production";
  return (facts) => {
    const ctx: DispatchContext = {
      id: facts.id ?? newDispatchId(),
      prefix: facts.prefix,
      functionName: facts.functionName ?? "",
      registeredNames: facts.registeredNames ?? [],
      originTier: facts.originTier,
      method: facts.method,
      declaredMethod: facts.declaredMethod,
      declaredContentType: facts.declaredContentType,
      actualContentType: facts.actualContentType,
      contentTypeMatched: facts.contentTypeMatched,
      argShape: argsShape(facts.args ?? []),
      status: facts.status,
      outcome: outcomeForStatus(facts.status),
      durationMs: Date.now() - facts.startedAt,
      ...(facts.error === undefined ? {} : {
        error: describeError(facts.error, { includeMessages, includeStacks }),
      }),
    };
    try {
      const result = onDispatch(ctx);
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch(() => {});
      }
    } catch {
      // Intentionally ignored — see the note above.
    }
  };
};

/** The mutable accumulator an adapter body writes into during a dispatch. */
export interface SeenDispatch {
  status: number;
  error?: unknown;
  functionName?: string;
  registered?: readonly string[];
  declaredMethod?: string;
  declaredContentType?: string;
  actualContentType?: string;
  contentTypeMatched?: boolean;
  args?: readonly unknown[];
  originTier: OriginTier;
}

/** How an adapter wraps its dispatch body to emit one record. */
export interface DispatchWrapOptions<T> {
  /** The emitter, or `undefined` when no hook is registered. */
  emit: EmitDispatch | undefined;
  /** The resolved prefix this middleware dispatches under. */
  prefix: string;
  /**
   * The request method. Supplied rather than read centrally because each adapter
   * spells it differently — `event.req.method`, `ctx.method`, `c.req.method` —
   * and a record that says `method: ""` is worse than no record.
   */
  method: () => string;
  /**
   * Reads the status the dispatch settled on. Adapters differ here — hono puts
   * it on the returned `Response`, koa on `ctx.status`, fastify on
   * `reply.statusCode` — which is why it is passed in rather than read centrally.
   *
   * It receives the result because that is where the status most reliably is:
   * hono's `c.json(body, 404)` returns a `Response` without setting `c.res`
   * inside the handler, so reading the context there would report 200 for every
   * failure.
   */
  readStatus: (result: T) => number;
  /**
   * Rewrites a failure result to carry the correlation id. Only called for a
   * `4xx`/`5xx`, and only when a hook is registered.
   *
   * Defaults to merging the id into a plain object, which is what every adapter
   * needs and none of them should be repeating: an adapter-specific copy of this
   * predicate is a copy nobody reads.
   *
   * May be async: hono returns a `Response`, whose body can only be read to be
   * rewritten, so its adapter has to clone and re-serialise.
   */
  withId?: (result: T, id: string) => T | Promise<T>;
  /**
   * Called with the correlation id **before** the body runs, for adapters that
   * have to know the id before the response is written — fastify sends through
   * `reply.send()`, so the body is already gone by the time `withId` would run.
   */
  onStart?: (id: string) => void;
  /** The dispatch body, unchanged, writing what it learns into `seen`. */
  run: (seen: SeenDispatch) => Promise<T> | T;
}

/**
 * Wraps an adapter's dispatch body so every exit path is observed.
 *
 * The reason this is a helper rather than a pattern copied four times: the four
 * adapters report through three different mechanisms, and a rule duplicated
 * across them is a rule that agrees with itself until someone edits one. The
 * facts are supplied, the record is assembled in one place, and an adapter only
 * has to say how to read its own status.
 *
 * With no `emit` this is close to a pass-through, which is what keeps the
 * correlation id — and the whole feature — off the default path.
 */
export const dispatchRequest = async <T>(
  { emit, prefix, method, readStatus, withId, onStart, run }:
    DispatchWrapOptions<T>,
): Promise<T> => {
  if (!emit) return await run({ status: 200, originTier: "headerless" });
  const tag = withId ??
    ((result: T, id: string) =>
      typeof result === "object" && result !== null
        ? ({ ...result, id } as T)
        : result);
  const startedAt = Date.now();
  const id = newDispatchId();
  // Before `run`, for adapters that have to know the id before the response is
  // written — fastify's `reply.send()` interceptor.
  onStart?.(id);
  const seen: SeenDispatch = { status: 200, originTier: "headerless" };
  try {
    const result = await run(seen);
    // Read after the body has settled: these adapters set the status on a host
    // object and return the body separately, so reading it earlier would report
    // the default for every failure.
    const status = readStatus(result);
    seen.status = status;
    if (status >= 400) return await tag(result, id);
    return result;
  } catch (err) {
    seen.error = err;
    seen.status = readStatus(undefined as T);
    throw err;
  } finally {
    emit({
      id,
      prefix,
      originTier: seen.originTier,
      method: method(),
      functionName: seen.functionName,
      registeredNames: seen.registered,
      declaredMethod: seen.declaredMethod,
      declaredContentType: seen.declaredContentType,
      actualContentType: seen.actualContentType,
      contentTypeMatched: seen.contentTypeMatched,
      args: seen.args,
      status: seen.status,
      error: seen.error,
      startedAt,
    });
  }
};

/**
 * Merges the correlation id into a `Response` body.
 *
 * Only hono needs this: it returns a `Response` rather than writing the body
 * anywhere the adapter owns, so by the time the id is known the body is already
 * serialised. Extracted here so the rules — never read a body twice, never
 * re-serialise a non-JSON or non-object one — are asserted once instead of
 * living inside an adapter closure.
 */
export const tagResponseId = async <T>(
  result: T,
  id: string,
): Promise<T> => {
  if (!(result instanceof Response)) return result;
  let parsed: unknown;
  try {
    // Cloned: the body of a Response can only be read once, and the caller may
    // still want to read the original.
    parsed = JSON.parse(await result.clone().text());
  } catch {
    return result;
  }
  // Arrays excluded: `{ ...[1, 2] }` is `{ 0: 1, 1: 2 }`, so spreading one would
  // replace a JSON array failure body with an object wearing its indices.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return result;
  }
  return new Response(JSON.stringify({ ...parsed, id }), {
    status: result.status,
    headers: result.headers,
  }) as T;
};

/**
 * The status a `Response`-returning dispatch settled on.
 *
 * hono is the only adapter that needs this — it returns a `Response` rather than
 * writing the body anywhere the adapter owns — and the fallback covers the one
 * path that returns nothing at all: the prefix gate, which the outer
 * `createMiddleware` has already rejected by the time it is reached.
 */
export const responseStatus = (result: unknown): number =>
  result instanceof Response ? result.status : 200;

/**
 * Merges the correlation id into a failure **body** an adapter owns — koa's
 * `ctx.body` and fastify's `reply.send()` argument, neither of which comes back
 * as the handler's return value.
 *
 * Arrays and scalars are returned untouched: `{ ...[1, 2] }` is
 * `{ 0: 1, 1: 2 }`, so spreading one would replace a JSON array failure body
 * with an object wearing its indices. Every adapter's failure body is a plain
 * object today, so the guard is there for the day one is not.
 */
export const tagBodyId = <T>(body: T, id: string): T =>
  body && typeof body === "object" && !Array.isArray(body)
    ? ({ ...body, id } as T)
    : body;
