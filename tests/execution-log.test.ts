/** @module Tests for the execution-context surface: the redacted arg shape, the error classifier, and the `onDispatch` emitter. The redaction is the load-bearing part, so it is asserted on its own. */
import { describe, expect, it, vi } from "vitest";

import {
  argShape,
  createDispatcher,
  describeError,
  dispatchRequest,
  newDispatchId,
  outcomeForStatus,
  responseStatus,
  tagBodyId,
  tagResponseId,
} from "../src/execution-log.ts";
import { NotFoundError, RPCError } from "../src/server-helpers.ts";

describe("argShape", () => {
  it("describes primitives by type and never by value", () => {
    expect(argShape("hunter2")).toBe("string");
    expect(argShape(42)).toBe("number");
    expect(argShape(true)).toBe("boolean");
    expect(argShape(null)).toBe("null");
    expect(argShape(undefined)).toBe("undefined");
    expect(argShape(1n)).toBe("bigint");
    expect(argShape(Symbol("s"))).toBe("symbol");
    expect(argShape(() => 1)).toBe("function");
  });

  it("does not leak a secret that is present in the value", () => {
    const shape = argShape({ password: "correct-horse-battery" });
    expect(shape).toBe("{password:string}");
    expect(shape).not.toContain("correct-horse");
  });

  it("names an object's keys with their types", () => {
    expect(argShape({ a: 1, b: "x", c: false })).toBe(
      "{a:number,b:string,c:boolean}",
    );
  });

  it("describes an array by its element shapes, deduplicated", () => {
    expect(argShape([1, 2, 3])).toBe("array[number]");
    expect(argShape([1, "a"])).toBe("array[number|string]");
    expect(argShape([])).toBe("array[]");
  });

  it("bounds depth, so a pathological input cannot produce a huge string", () => {
    expect(argShape({ a: { b: { c: { d: 1 } } } })).toBe(
      "{a:{b:{c:object(…)}}}",
    );
  });

  it("bounds the number of keys and counts the rest", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`k${i}`, i]),
    );
    const shape = argShape(wide);
    expect(shape.split(",")).toHaveLength(9); // 8 keys + "+4 more"
    expect(shape).toContain("+4 more");
  });

  it("reports a genuine cycle rather than recursing forever", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(argShape(cyclic)).toBe("{self:circular}");

    const arr: unknown[] = [];
    arr.push(arr);
    expect(argShape(arr)).toBe("array[circular]");
  });

  it("describes a shared subobject twice, because that is a DAG and not a cycle", () => {
    // Scoped to the path, not the whole object graph: a value reachable by two
    // sibling keys is not circular, and reporting it as such would be a lie
    // about the shape.
    const shared = { x: 1 };
    expect(argShape({ a: shared, b: shared })).toBe(
      "{a:{x:number},b:{x:number}}",
    );
  });
});

describe("outcomeForStatus", () => {
  it("derives the outcome from the status so the two cannot disagree", () => {
    expect(outcomeForStatus(200)).toBe("ok");
    expect(outcomeForStatus(400)).toBe("client-error");
    expect(outcomeForStatus(404)).toBe("client-error");
    expect(outcomeForStatus(500)).toBe("server-error");
    expect(outcomeForStatus(503)).toBe("server-error");
  });
});

describe("describeError", () => {
  it("classifies an RPCError by its brand, not by instanceof", () => {
    // Built by hand: the point is that a cross-bundle copy is still recognised.
    const record = describeError({
      [Symbol.for("thednp.rpc.error")]: true,
      name: "ValidationError",
      code: "VALIDATION",
    });
    expect(record).toMatchObject({
      name: "ValidationError",
      code: "VALIDATION",
      isRPCError: true,
    });
  });

  it("marks an unexpected throw as not an RPCError", () => {
    expect(describeError(new Error("boom"))).toMatchObject({
      name: "Error",
      isRPCError: false,
    });
  });

  it("omits the message unless asked, because a message can quote the input", () => {
    const err = new NotFoundError("user 42 has no order", "check the id");
    expect(describeError(err).message).toBeUndefined();
    expect(describeError(err, { includeMessages: true }).message).toBe(
      "user 42 has no order",
    );
  });

  it("omits the stack unless asked", () => {
    const err = new Error("boom");
    expect(describeError(err).stack).toBeUndefined();
    expect(describeError(err, { includeStacks: true }).stack).toBe(err.stack);
  });

  it("names an unrecognised throw rather than reporting no name", () => {
    // `throw { oops: true }` has no `name`, and a record that says
    // `name: undefined` is harder to read than one that says "Error".
    expect(describeError({ oops: true }).name).toBe("Error");
  });

  it("defaults a code for a branded error that has none", () => {
    expect(
      describeError({ [Symbol.for("thednp.rpc.error")]: true, name: "X" }).code,
    ).toBe("INTERNAL");
  });
});

describe("newDispatchId", () => {
  it("produces a short, url-safe, unhyphenated id", () => {
    const id = newDispatchId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not repeat across calls", () => {
    expect(newDispatchId()).not.toBe(newDispatchId());
  });
});

describe("createDispatcher", () => {
  const facts = {
    prefix: "__rpc",
    originTier: "headerless" as const,
    method: "POST",
    status: 200,
    startedAt: Date.now(),
  };

  it("returns undefined with no hook, so an adapter skips the work entirely", () => {
    // This is what keeps the correlation id off failure responses by default:
    // with nobody collecting, the error body stays byte-for-byte what it was.
    expect(createDispatcher()).toBeUndefined();
    expect(createDispatcher(undefined)).toBeUndefined();
  });

  it("emits a complete context, shaping the args", () => {
    const seen: unknown[] = [];
    createDispatcher((ctx) => {
      seen.push(ctx);
    })?.({
      ...facts,
      functionName: "add",
      args: [{ a: 1, password: "x" }],
      error: new NotFoundError("nope", "check the id"),
    });
    const ctx = seen[0] as Record<string, unknown>;
    expect(ctx).toMatchObject({
      prefix: "__rpc",
      functionName: "add",
      originTier: "headerless",
      method: "POST",
      status: 200,
      outcome: "ok",
      argShape: "[{a:number,password:string}]",
    });
    expect(typeof ctx.durationMs).toBe("number");
    expect(JSON.stringify(ctx)).not.toContain('"x"');
  });

  it("defaults the optional fields rather than emitting undefined keys", () => {
    const seen: Record<string, unknown>[] = [];
    createDispatcher((ctx) => {
      seen.push(ctx as unknown as Record<string, unknown>);
    })?.(facts);
    expect(seen[0].functionName).toBe("");
    expect(seen[0].registeredNames).toEqual([]);
    expect("error" in seen[0]).toBe(false);
  });

  it("uses a pre-minted id when the adapter already put it on the response", () => {
    const seen: { id: string }[] = [];
    createDispatcher((ctx) => {
      seen.push({ id: ctx.id });
    })?.({ ...facts, id: "fixed-id" });
    expect(seen[0].id).toBe("fixed-id");
  });

  it("mints its own id otherwise", () => {
    const seen: { id: string }[] = [];
    createDispatcher((ctx) => {
      seen.push({ id: ctx.id });
    })?.(facts);
    expect(seen[0].id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("swallows a throwing hook — a logger must not take down the request", () => {
    const emit = createDispatcher(() => {
      throw new Error("log exploded");
    });
    expect(() => emit?.(facts)).not.toThrow();
  });

  it("swallows a rejecting hook too", async () => {
    const emit = createDispatcher(() =>
      Promise.reject(new Error("async boom"))
    );
    expect(() => emit?.(facts)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it("strips messages and stacks outside development", () => {
    // A record is a debug aid; in production it should carry the classification
    // and not the text of the failure, which can quote the input.
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const seen: {
        error?: { message?: string; stack?: string; isRPCError?: boolean };
      }[] = [];
      createDispatcher((ctx) => {
        seen.push(ctx as never);
      })?.({
        ...facts,
        error: new NotFoundError("user 42 has no order", "check the id"),
      });
      expect(seen[0].error?.message).toBeUndefined();
      expect(seen[0].error?.stack).toBeUndefined();
      expect(seen[0].error?.isRPCError).toBe(true);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("accepts a sync hook and a void return", () => {
    const hook = vi.fn();
    createDispatcher(hook)?.(facts);
    expect(hook).toHaveBeenCalledTimes(1);
  });
});

describe("RPCError brand", () => {
  it("is present on an RPCError instance", () => {
    expect(isBranded(new RPCError("x"))).toBe(true);
  });
});

const isBranded = (err: unknown): boolean =>
  (err as Record<symbol, unknown>)[Symbol.for("thednp.rpc.error")] === true;

/* ─── dispatchRequest — the shared wrapper ─────────────────────────────────
 * Four adapters report through three different mechanisms, so the rule lives
 * here once and each adapter only says how to read its own status.
 */

describe("dispatchRequest", () => {
  const base = {
    prefix: "__rpc",
    method: () => "POST",
    readStatus: () => 200,
  };

  it("is a pass-through with no hook", async () => {
    const result = await dispatchRequest({
      ...base,
      emit: undefined,
      run: () => ({ data: "ok" }),
    });
    expect(result).toEqual({ data: "ok" });
  });

  it("reads the status after the body settles, not before", async () => {
    // These adapters set the status on a host object and return the body
    // separately, so reading earlier would report the default for every failure.
    let status = 200;
    const seen: { status?: number; id?: string }[] = [];
    const result = await dispatchRequest({
      ...base,
      emit: createDispatcher((ctx) => {
        seen.push(ctx);
      }),
      readStatus: () => status,
      run: () => {
        status = 418;
        return { error: "teapot" };
      },
    });
    // 418 is a failure, so the id is merged in by the default `tag`.
    expect(result).toEqual({ error: "teapot", id: seen[0].id });
    expect(seen[0].status).toBe(418);
  });

  it("adds the id to a failure body only", async () => {
    const seen: { id: string }[] = [];
    const emit = createDispatcher((ctx) => {
      seen.push({ id: ctx.id });
    });
    const fail = await dispatchRequest({
      ...base,
      emit,
      readStatus: () => 404,
      withId: (r, id) => ({ ...r, id }),
      run: () => ({ error: "gone" }),
    });
    expect(fail).toEqual({ error: "gone", id: seen[0].id });

    const ok = await dispatchRequest({
      ...base,
      emit,
      withId: (r, id) => ({ ...r, id }),
      run: () => ({ data: "ok" }),
    });
    expect(ok).toEqual({ data: "ok" });
  });

  it("records a throw that escapes the body, and rethrows it", async () => {
    // The five adapters catch inside their own bodies and report through `seen`,
    // so this path is the safety net for an adapter that does not — asserted
    // directly rather than through a framework.
    const seen: { status?: number; error?: { name?: string } }[] = [];
    await expect(
      dispatchRequest({
        ...base,
        emit: createDispatcher((ctx) => {
          seen.push(ctx);
        }),
        readStatus: () => 500,
        run: () => {
          throw new Error("escaped");
        },
      }),
    ).rejects.toThrow("escaped");
    // The record carries the *described* error, not the throw itself — a
    // classification and, outside development, not the text.
    expect(seen[0].error).toMatchObject({ name: "Error", isRPCError: false });
    expect(seen[0].status).toBe(500);
  });

  it("merges the id into a plain object body by default", async () => {
    // The default `tag`, which is what every adapter uses. Each one used to
    // carry its own copy of this predicate; centralising it means the rule is
    // asserted once instead of four times.
    const seen: { id: string }[] = [];
    const result = await dispatchRequest({
      ...base,
      emit: createDispatcher((ctx) => {
        seen.push({ id: ctx.id });
      }),
      readStatus: () => 500,
      run: () => ({ error: "boom" }),
    });
    expect(result).toEqual({ error: "boom", id: seen[0].id });
  });

  it("leaves a non-object failure result alone", async () => {
    // Every adapter's failure body is an object, so the "not an object" arm is
    // reached through the helper directly rather than contrived through a
    // framework request.
    const result = await dispatchRequest({
      ...base,
      emit: createDispatcher(() => {}),
      readStatus: () => 500,
      run: () => "a string body",
    });
    expect(result).toBe("a string body");
  });

  it("leaves a null failure result alone rather than spreading it", async () => {
    // `{ ...null }` is `{}`, which would replace a legitimately empty body with
    // one carrying nothing but an id — so null is excluded explicitly.
    const result = await dispatchRequest({
      ...base,
      emit: createDispatcher(() => {}),
      readStatus: () => 500,
      run: () => null,
    });
    expect(result).toBeNull();
  });

  it("still honours a caller-supplied withId", async () => {
    const result = await dispatchRequest({
      ...base,
      emit: createDispatcher(() => {}),
      readStatus: () => 500,
      withId: (r, id) => `wrapped:${id}:${String(r)}` as unknown as typeof r,
      run: () => "raw",
    });
    expect(String(result)).toMatch(/^wrapped:[0-9a-f]{16}:raw$/);
  });
});

/* ─── tagResponseId — hono's response rewrite ────────────────────────────── */

describe("tagResponseId", () => {
  const json = (body: unknown, status = 400) =>
    new Response(JSON.stringify(body), { status });

  it("merges the id into a JSON object body, keeping status and headers", async () => {
    const tagged = await tagResponseId(
      json({ error: "gone" }, 404),
      "abc123",
    );
    expect(tagged.status).toBe(404);
    expect(await (tagged as Response).json()).toEqual({
      error: "gone",
      id: "abc123",
    });
  });

  it("leaves the original readable — it clones before reading", async () => {
    // A Response body can only be read once, so reading it without cloning
    // would consume the body the caller may still want.
    const original = json({ error: "gone" });
    await tagResponseId(original, "abc123");
    expect(await original.json()).toEqual({ error: "gone" });
  });

  it("leaves a non-Response result alone", async () => {
    expect(await tagResponseId("plain", "abc123")).toBe("plain");
    expect(await tagResponseId(undefined, "abc123")).toBeUndefined();
  });

  it("leaves a non-JSON body alone rather than corrupting it", async () => {
    const text = new Response("not json at all", { status: 500 });
    expect(await tagResponseId(text, "abc123")).toBe(text);
  });

  it("leaves a JSON scalar or array alone rather than spreading it", async () => {
    for (const body of [42, "a string", true]) {
      const res = json(body, 500);
      expect(await tagResponseId(res, "abc123")).toBe(res);
    }
    // An array *is* an object, and `{...[]}` is `{}` — so a JSON array failure
    // body would be silently replaced. Kept as-is rather than spread.
    const arr = json([1, 2], 500);
    expect(await tagResponseId(arr, "abc123")).toBe(arr);
  });
});

describe("responseStatus", () => {
  it("reads the status off a Response", () => {
    expect(responseStatus(new Response("{}", { status: 418 }))).toBe(418);
  });

  it("falls back to 200 for anything that is not a Response", () => {
    // The one path that returns nothing: the prefix gate, which the outer
    // `createMiddleware` has already rejected by the time it is reached.
    expect(responseStatus(undefined)).toBe(200);
    expect(responseStatus({ error: "x" })).toBe(200);
  });
});

describe("tagBodyId", () => {
  it("merges the id into a plain object", () => {
    expect(tagBodyId({ error: "gone" }, "abc")).toEqual({
      error: "gone",
      id: "abc",
    });
  });

  it("leaves a scalar, a null and an array untouched", () => {
    // `{ ...[1, 2] }` is `{ 0: 1, 1: 2 }`, so an array would be replaced by an
    // object wearing its indices rather than gaining an id.
    for (const body of ["raw", 42, null, undefined, [1, 2]] as unknown[]) {
      expect(tagBodyId(body, "abc")).toBe(body);
    }
  });

  it("does not mutate the body it was given", () => {
    const body = { error: "gone" };
    tagBodyId(body, "abc");
    expect(body).toEqual({ error: "gone" });
  });
});
