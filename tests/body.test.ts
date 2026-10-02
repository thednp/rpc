/** @module Tests for the shared body-parsing policy (`src/body.ts`). */
import { describe, expect, it } from "vitest";

import { PassThrough } from "node:stream";

import {
  assertBodyWithinLimit,
  bodyKind,
  parseRawBody,
  parseSniffedText,
  preParsedBody,
  readStream,
  readWebBody,
} from "../src/body.ts";
import type { WebBodySource } from "../src/body.ts";
import { clientErrorStatus, isClientHttpError } from "../src/server-helpers.ts";
import { DEFAULT_BODY_LIMIT } from "../src/constants.ts";

/** Feeds `body` to a PassThrough in `size`-byte pieces and resolves the result. */
const stream = (body: string, size: number, opts?: { limit?: number }) => {
  const src = new PassThrough();
  const result = readStream(src, "application/json", opts);
  for (let i = 0; i < body.length; i += size) {
    src.write(body.slice(i, i + size));
  }
  src.end();
  return result;
};

describe("bodyKind", () => {
  it("classifies each structural branch", () => {
    expect(bodyKind("application/json")).toBe("json");
    expect(bodyKind("multipart/form-data; boundary=----abc")).toBe("multipart");
    expect(bodyKind("application/x-www-form-urlencoded")).toBe("urlencoded");
  });

  it("falls back to text when no Content-Type is declared", () => {
    expect(bodyKind(undefined)).toBe("text");
    expect(bodyKind("")).toBe("text");
    expect(bodyKind("text/plain")).toBe("text");
  });

  it("is case-insensitive", () => {
    expect(bodyKind("Application/JSON")).toBe("json");
    expect(bodyKind("MULTIPART/FORM-DATA")).toBe("multipart");
  });

  it("treats a vendor +json type as JSON", () => {
    // Substring, not exact base-type — long-standing behaviour, and the reason
    // this deliberately differs from `hasContentTypeMismatch`.
    expect(bodyKind("application/vnd.api+json")).toBe("json");
  });

  it("tests multipart before json, so a boundary cannot flip the branch", () => {
    // The boundary is attacker-influenced text. If "json" were tested first, a
    // boundary containing that substring would route a multipart body into the
    // JSON branch and answer 400 for a perfectly valid upload.
    expect(
      bodyKind("multipart/form-data; boundary=--json--"),
    ).toBe("multipart");
  });
});

describe("parseSniffedText", () => {
  it("parses when the text is JSON", () => {
    expect(parseSniffedText('{"hello":"world"}')).toEqual({ hello: "world" });
    expect(parseSniffedText("[1,2]")).toEqual([1, 2]);
  });

  it("returns the original string when it does not parse", () => {
    expect(parseSniffedText("not-json")).toBe("not-json");
    expect(parseSniffedText("")).toBe("");
  });
});

describe("parseRawBody", () => {
  it("keeps multipart as a raw string envelope", () => {
    const result = parseRawBody("--bound\r\n", "multipart/form-data");
    expect(result.contentType).toBe("multipart/form-data");
    expect(result).toEqual({
      contentType: "multipart/form-data",
      data: { raw: "--bound\r\n" },
    });
  });

  it("decodes urlencoded into an object", () => {
    const result = parseRawBody(
      "a=1&b=two",
      "application/x-www-form-urlencoded",
    );
    expect(result.contentType).toBe("application/x-www-form-urlencoded");
    expect(result).toEqual({
      contentType: "application/x-www-form-urlencoded",
      data: { a: "1", b: "two" },
    });
  });

  it("parses a declared JSON body strictly", () => {
    expect(parseRawBody('{"a":1}', "application/json")).toEqual({
      contentType: "application/json",
      data: { a: 1 },
    });
  });

  it("rejects a declared JSON body that does not parse", () => {
    // This is the 0.3.7 fix. Recovering into `text/plain` made a malformed body
    // indistinguishable from a legitimate text body and answered 200.
    let thrown: unknown;
    try {
      parseRawBody("{not json", "application/json");
    } catch (err) {
      thrown = err;
    }
    expect(isClientHttpError(thrown)).toBe(true);
    expect((thrown as { status?: number }).status).toBe(400);
  });

  it("sniffs an undeclared body", () => {
    // curl and the nojs form fallback send JSON with no Content-Type; it must
    // still arrive parsed.
    const result = parseRawBody('{"hello":"world"}', undefined);
    expect(result.data).toEqual({ hello: "world" });
    // The label reflects the *declared* type, which is absent — pre-existing
    // behaviour, not a side effect of the sniff.
    expect(result.contentType).toBe("text/plain");
  });

  it("keeps an undeclared non-JSON body as text", () => {
    const result = parseRawBody("plain words", undefined);
    expect(result).toEqual({ contentType: "text/plain", data: "plain words" });
  });

  it("does not let a `__proto__` field reach Object.prototype", () => {
    // Prototype pollution is the class of bug tRPC hit in CVE-2025-68130.
    // `Object.fromEntries` and `JSON.parse` both create an *own* property named
    // `__proto__`, so the key stays inert data and the prototype is untouched.
    //
    // The bracket vector (`__proto__[polluted]=yes`) is a separate parser
    // feature: `URLSearchParams` does not expand brackets, so the key arrives
    // as the literal string and is doubly inert. Both are asserted.
    const viaForm = parseRawBody(
      "__proto__=yes&__proto__[polluted]=yes&a=1",
      "application/x-www-form-urlencoded",
    );
    const formData = viaForm.data as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(formData, "__proto__")).toBe(
      true,
    );
    expect(Object.keys(formData)).toContain("__proto__");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(formData)).toBe(Object.prototype);

    const viaJson = parseRawBody(
      '{"__proto__":{"polluted":"yes"}}',
      "application/json",
    );
    expect(Object.getPrototypeOf(viaJson.data)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("preParsedBody", () => {
  it("passes decoded JSON straight through", () => {
    expect(preParsedBody({ a: 1 }, "application/json")).toEqual({
      contentType: "application/json",
      data: { a: 1 },
    });
  });

  it("passes decoded form data through without re-wrapping", () => {
    // Note: no `{ raw }` envelope here, unlike parseRawBody. The host parser
    // already produced an object, so wrapping it would be wrong.
    expect(
      preParsedBody({ field: "v" }, "multipart/form-data"),
    ).toEqual({
      contentType: "multipart/form-data",
      data: { field: "v" },
    });
  });

  it("stringifies the text branch, because there is no raw text left to sniff", () => {
    expect(preParsedBody(42, undefined)).toEqual({
      contentType: "text/plain",
      data: "42",
    });
  });
});

describe("readStream", () => {
  it("parses a body within the cap", async () => {
    const result = await stream('["ok"]', 1);
    expect(result).toEqual({ contentType: "application/json", data: ["ok"] });
  });

  it("rejects with 413 when the body exceeds the cap", async () => {
    const err = await stream(JSON.stringify(["x".repeat(500)]), 64, {
      limit: 100,
    }).then(() => null, (e) => e);
    expect(clientErrorStatus(err)).toBe(413);
  });

  it("accepts a body exactly at the cap", async () => {
    // `>` not `>=`: a body of precisely the limit is allowed.
    const body = JSON.stringify(["a".repeat(90)]);
    const result = await stream(body, 16, { limit: body.length });
    expect(result.contentType).toBe("application/json");
  });

  it("does not retain the bytes past the cap", async () => {
    // The guarantee is a bounded footprint, so this asserts the buffer is
    // released rather than merely that the status is 413.
    const src = new PassThrough();
    const result = readStream(src, "application/json", { limit: 64 });
    let retained = 0;
    src.on("data", () => {
      retained = Math.max(retained, src.readableLength);
    });
    for (let i = 0; i < 40; i++) src.write("x".repeat(1024));
    src.end();
    await expect(result).rejects.toBeDefined();
    // Chunks are pushed by the producer, so the best observable statement is
    // that we never accumulate them: 40 KiB was offered and the promise settled
    // on the cap rather than on the end of the stream.
    expect(retained).toBeLessThan(40 * 1024);
  });

  it("cuts the connection when the drain ceiling is passed", async () => {
    // A client that keeps pushing long after the verdict must not be able to
    // turn the discard into an unbounded slowloris.
    const src = new PassThrough();
    const result = readStream(src, "application/json", {
      limit: 16,
      drainLimit: 32,
    });
    let destroyed = false;
    // `close` is emitted asynchronously, so it has to be awaited rather than
    // sampled the instant the rejection settles.
    const closed = new Promise<void>((resolve) => {
      src.on("close", () => {
        destroyed = true;
        resolve();
      });
    });
    for (let i = 0; i < 50; i++) src.write("x".repeat(64));
    src.end();
    await expect(result).rejects.toBeDefined();
    await closed;
    expect(destroyed).toBe(true);
    expect(src.destroyed).toBe(true);
  });

  it("keeps the first verdict when the stream errors after settling", async () => {
    // `destroy()` can emit an error after the 413 has already settled, and a
    // body can error after `end`. Without the re-entrancy guard the second
    // settle would be a no-op Promise, or worse, a second reject.
    const src = new PassThrough();
    const result = readStream(src, "application/json", { limit: 8 });
    src.end('["ok"]');
    const first = await result;
    expect(first).toEqual({ contentType: "application/json", data: ["ok"] });
    // `finish` detached our listener, so the emission needs a sink — an
    // EventEmitter with no `error` listener throws, which is the very proof
    // that the detach happened.
    src.on("error", () => {});
    src.emit("error", new Error("late failure"));
    await expect(result).resolves.toEqual(first);
  });

  it("treats limit 0 as no cap", async () => {
    const body = JSON.stringify(["x".repeat(2000)]);
    const result = await stream(body, 256, { limit: 0 });
    expect(result.contentType).toBe("application/json");
  });

  it("still answers 400 for unparseable declared JSON under the cap", async () => {
    const err = await stream("{not json", 4, { limit: 1024 }).then(
      () => null,
      (e) => e,
    );
    expect(clientErrorStatus(err)).toBe(400);
  });

  it("defaults to DEFAULT_BODY_LIMIT", () => {
    expect(DEFAULT_BODY_LIMIT).toBe(10 * 1024 * 1024);
  });
});

describe("assertBodyWithinLimit", () => {
  it("rejects a declared length over the cap", () => {
    expect(() => assertBodyWithinLimit("200", 100)).toThrow();
    try {
      assertBodyWithinLimit("200", 100);
    } catch (err) {
      expect(clientErrorStatus(err)).toBe(413);
    }
  });

  it("allows a declared length within the cap", () => {
    expect(() => assertBodyWithinLimit("100", 100)).not.toThrow();
  });

  it("ignores an absent, non-numeric, or negative Content-Length", () => {
    // Chunked encoding legitimately has none, so absence is not a signal.
    expect(() => assertBodyWithinLimit(undefined, 1)).not.toThrow();
    expect(() => assertBodyWithinLimit(null, 1)).not.toThrow();
    expect(() => assertBodyWithinLimit("", 1)).not.toThrow();
    expect(() => assertBodyWithinLimit("abc", 1)).not.toThrow();
    expect(() => assertBodyWithinLimit("-5", 1)).not.toThrow();
  });

  it("is a no-op when the cap is disabled", () => {
    expect(() => assertBodyWithinLimit("999999", 0)).not.toThrow();
  });
});

describe("readWebBody", () => {
  /** A Web `Request` carrying `body`, as h3's `event.req` and Hono's `c.req.raw` do. */
  const webReq = (body?: BodyInit | null, contentType?: string) =>
    new Request("http://localhost/", {
      method: "POST",
      headers: contentType ? { "content-type": contentType } : undefined,
      ...(body === undefined || body === null
        ? {}
        : { body, duplex: "half" as const }),
    });

  it("parses a JSON body within the cap", async () => {
    const result = await readWebBody(
      webReq('["ok"]', "application/json"),
      "application/json",
    );
    expect(result).toEqual({ contentType: "application/json", data: ["ok"] });
  });

  it("rejects with 413 when the body exceeds the cap", async () => {
    // This is the case a Content-Length pre-check cannot catch: a Request built
    // in JavaScript carries no Content-Length header at all.
    const err = await readWebBody(
      webReq(`["${"x".repeat(4096)}"]`, "application/json"),
      "application/json",
      { limit: 512 },
    ).then(() => null, (e) => e);
    expect(clientErrorStatus(err)).toBe(413);
  });

  it("caps a stream with no Content-Length", async () => {
    const req = webReq(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`["${"x".repeat(4096)}"]`));
          c.close();
        },
      }),
      "application/json",
    );
    const err = await readWebBody(req, "application/json", { limit: 512 }).then(
      () => null,
      (e) => e,
    );
    expect(clientErrorStatus(err)).toBe(413);
  });

  it("accepts a body exactly at the cap", async () => {
    const body = `["${"a".repeat(90)}"]`;
    const result = await readWebBody(
      webReq(body, "application/json"),
      "application/json",
      {
        limit: body.length,
      },
    );
    expect(result.contentType).toBe("application/json");
  });

  it("falls back to text() when the body is already consumed", async () => {
    // A framework body-limit middleware got there first. A raw `Request` would
    // now throw "Body is unusable", but a framework's own accessor returns the
    // value it cached, so the fallback is what the adapters actually rely on and
    // that middleware's limit is the operative one. Modelled as a structural
    // `WebBodySource` rather than a real `Request`, since the Fetch spec forbids
    // the re-read a real one would do.
    const consumed: WebBodySource = {
      body: null,
      bodyUsed: true,
      text: async () => '["ok"]',
    };
    const result = await readWebBody(consumed, "application/json", {
      limit: 1,
    });
    expect(result).toEqual({ contentType: "application/json", data: ["ok"] });
  });

  it("handles a null body", async () => {
    const result = await readWebBody(webReq(undefined), undefined, {
      limit: 512,
    });
    expect(result).toEqual({ contentType: "text/plain", data: "" });
  });

  it("still answers 400 for unparseable declared JSON under the cap", async () => {
    const err = await readWebBody(
      webReq("{not json", "application/json"),
      "application/json",
      {
        limit: 1024,
      },
    ).then(() => null, (e) => e);
    expect(clientErrorStatus(err)).toBe(400);
  });

  it("propagates a mid-stream failure without masking it as a client error", async () => {
    // A transport error part-way through is not a 4xx, so it must not be
    // relabelled — the same rule as the Node path, where a stream `error` event
    // rejects with the original error.
    const req = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('["partial'));
          c.error(new Error("connection reset"));
        },
      }),
      duplex: "half",
    } as RequestInit);
    await expect(readWebBody(req, "application/json", { limit: 4096 }))
      .rejects.toThrow(/connection reset/);
  });

  it("treats limit 0 as no cap", async () => {
    const body = `["${"x".repeat(4096)}"]`;
    const result = await readWebBody(
      webReq(body, "application/json"),
      "application/json",
      {
        limit: 0,
      },
    );
    expect(result.contentType).toBe("application/json");
  });
});
