import { describe, expect, it } from "vitest";
import {
  clientErrorMessage,
  clientErrorStatus,
  ConflictError,
  describeOriginRequest,
  ForbiddenError,
  formatError,
  hasContentTypeMismatch,
  httpError,
  isClientHttpError,
  isFormContentType,
  isOriginAllowed,
  isOriginRequestAllowed,
  isRPCError,
  NotFoundError,
  RPCError,
  safeURL,
  walkGlobFiles,
} from "../src/server-helpers.ts";

describe("clientErrorMessage", () => {
  it("maps 413 to Payload Too Large", () => {
    expect(clientErrorMessage(413)).toBe("Payload Too Large");
  });

  it("maps 415 to Unsupported Media Type", () => {
    expect(clientErrorMessage(415)).toBe("Unsupported Media Type");
  });

  // A thrown `NotFoundError` is answered 404; before the table grew, its body
  // said "Bad Request", which is a right status carrying a wrong meaning.
  it("maps the statuses a typed RPCError subclass can carry", () => {
    expect(clientErrorMessage(403)).toBe("Forbidden");
    expect(clientErrorMessage(404)).toBe("Not Found");
    expect(clientErrorMessage(409)).toBe("Conflict");
  });

  it("falls back to Bad Request for every other client error", () => {
    // 422 is deliberately absent: it has its own entry, so a validation failure
    // is not reported as "Bad Request" just because the table's last branch
    // catches it. That was the bug the entry was added to prevent.
    for (const s of [400, 401, 402, 499]) {
      expect(clientErrorMessage(s)).toBe("Bad Request");
    }
  });

  it("answers a 422 with its own reason phrase, never `Bad Request`", () => {
    // Without this entry, a 422 would ship the string "Bad Request" — the right
    // status carrying the wrong meaning.
    expect(clientErrorMessage(422)).toBe("Unprocessable Content");
    expect(clientErrorMessage(422)).not.toBe("Bad Request");
  });
});

describe("isClientHttpError", () => {
  it("accepts a numeric status in the 4xx range", () => {
    expect(isClientHttpError(httpError(400, "x"))).toBe(true);
    expect(isClientHttpError(httpError(413, "x"))).toBe(true);
    expect(isClientHttpError(httpError(499, "x"))).toBe(true);
  });

  it("reads statusCode as well as status", () => {
    // Express's http-errors objects and Koa's ctx.throw carry `statusCode`.
    expect(isClientHttpError({ statusCode: 400 })).toBe(true);
  });

  it("reads a statusCode-only error, as Express http-errors and Koa throw", () => {
    expect(clientErrorStatus({ statusCode: 413 })).toBe(413);
    expect(clientErrorStatus({ statusCode: 415 })).toBe(415);
    expect(clientErrorStatus({ statusCode: 418 })).toBe(418);
  });

  it("defaults to 400 for anything it cannot read", () => {
    expect(clientErrorStatus(new Error("plain"))).toBe(400);
    expect(clientErrorStatus({ status: 500 })).toBe(400);
    expect(clientErrorStatus(undefined)).toBe(400);
  });

  it("rejects 5xx, non-numeric, and absent statuses", () => {
    expect(isClientHttpError({ status: 500 })).toBe(false);
    expect(isClientHttpError({ status: 399 })).toBe(false);
    expect(isClientHttpError({ status: "400" })).toBe(false);
    expect(isClientHttpError(new Error("plain"))).toBe(false);
    expect(isClientHttpError(null)).toBe(false);
    expect(isClientHttpError(undefined)).toBe(false);
  });
});

describe("httpError", () => {
  it("tags the error with the status and keeps a diagnostic message", () => {
    const err = httpError(400, "Invalid JSON body");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(400);
    expect(err.message).toBe("Invalid JSON body");
  });
});

describe("isOriginAllowed", () => {
  it("should allow everything when no allowlist is configured", () => {
    expect(isOriginAllowed(undefined, "https://evil.com")).toBe(true);
    expect(isOriginAllowed(undefined, undefined)).toBe(true);
  });

  it("should allow headerless requests when an allowlist is configured", () => {
    expect(isOriginAllowed("https://app.example.com", undefined)).toBe(true);
    expect(
      isOriginAllowed(["https://app.example.com"], undefined),
    ).toBe(true);
  });

  it("should match a single string exactly", () => {
    expect(
      isOriginAllowed("https://app.example.com", "https://app.example.com"),
    )
      .toBe(true);
    expect(isOriginAllowed("https://app.example.com", "https://evil.com"))
      .toBe(false);
  });

  it("should match any entry of an allowlist array", () => {
    const allowed = ["https://app.example.com", "https://admin.example.com"];
    expect(isOriginAllowed(allowed, "https://app.example.com")).toBe(true);
    expect(isOriginAllowed(allowed, "https://admin.example.com")).toBe(true);
    expect(isOriginAllowed(allowed, "https://evil.com")).toBe(false);
  });

  it("should treat a one-element array like the equivalent string", () => {
    expect(
      isOriginAllowed(["https://app.example.com"], "https://app.example.com"),
    )
      .toBe(true);
  });

  it('should reject Origin: "null" when an allowlist is set', () => {
    expect(isOriginAllowed("https://app.example.com", "null")).toBe(false);
    expect(isOriginAllowed(["https://app.example.com"], "null")).toBe(false);
  });

  it("should not match on prefix or substring", () => {
    expect(
      isOriginAllowed(
        "https://app.example.com",
        "https://app.example.com.evil.com",
      ),
    ).toBe(false);
    expect(
      isOriginAllowed("https://app.example.com", "https://app.example.com:443"),
    ).toBe(false);
  });

  it("should be case-sensitive, matching the serialized Origin form", () => {
    expect(
      isOriginAllowed(
        "https://app.example.com",
        "HTTPS://APP.EXAMPLE.COM",
      ),
    ).toBe(false);
  });

  it("should deny any request carrying an Origin when given an empty allowlist", () => {
    expect(isOriginAllowed([], "https://app.example.com")).toBe(false);
    // …but headerless requests still pass, same as with any other allowlist
    expect(isOriginAllowed([], undefined)).toBe(true);
  });

  it("should be exported from the server barrel", async () => {
    const barrel = await import("../src/server.ts");
    expect(typeof barrel.isOriginAllowed).toBe("function");
  });
});

describe("isOriginRequestAllowed", () => {
  const HOST = "app.example.com";
  const SELF = "https://app.example.com";
  const ALLOW = ["https://example.com", "https://admin.example.com"];

  describe('the secure default — an absent policy is "self", not "unchecked"', () => {
    it("rejects a foreign Origin", () => {
      expect(
        isOriginRequestAllowed({
          origin: "https://evil.com",
          site: "cross-site",
          host: HOST,
        }),
      ).toBe(false);
    });

    it("admits the server's own host", () => {
      expect(isOriginRequestAllowed({ origin: SELF, host: HOST })).toBe(true);
    });

    it("rejects a headerless request", () => {
      expect(
        isOriginRequestAllowed({ host: HOST }),
      ).toBe(false);
    });

    it('resolves an explicitly undefined policy to "self" rather than to no check', () => {
      // `Object.assign(defaults, options)` copies an explicit
      // `origin: undefined` over the default, so the helper has to make the
      // secure choice itself. Otherwise `origin: undefined` would be a
      // one-liner that silently disables the protection.
      expect(
        isOriginRequestAllowed({
          allowed: undefined,
          origin: "https://evil.com",
          host: HOST,
        }),
      ).toBe(false);
      expect(
        isOriginRequestAllowed({
          allowed: undefined,
          origin: SELF,
          host: HOST,
        }),
      ).toBe(true);
    });

    it('never treats "self" as a literal origin string', () => {
      // Guards the `allowed === "self"` branch from falling through to the
      // exact-match path, where it would be compared as a literal and match
      // nothing.
      expect(
        isOriginRequestAllowed({ allowed: "self", origin: "self", host: HOST }),
      ).toBe(false);
    });
  });

  describe("host-only comparison", () => {
    it("ignores the scheme, so TLS termination needs no action", () => {
      expect(
        isOriginRequestAllowed({
          origin: "http://app.example.com",
          host: HOST,
        }),
      ).toBe(true);
    });

    it("drops a default port, matching the Host a browser sends", () => {
      // `new URL` normalises `https://host:443` to `host`. Without this a
      // browser behind TLS termination would carry a port the Host header
      // lacks and every POST would be rejected.
      expect(
        isOriginRequestAllowed({
          origin: "https://app.example.com:443",
          host: HOST,
        }),
      ).toBe(true);
    });

    it("still requires a non-default port to match", () => {
      expect(
        isOriginRequestAllowed({
          origin: "https://app.example.com:8443",
          host: HOST,
        }),
      ).toBe(false);
      expect(
        isOriginRequestAllowed({
          origin: "https://app.example.com:8443",
          host: "app.example.com:8443",
        }),
      ).toBe(true);
    });

    it("compares the host case-insensitively", () => {
      expect(
        isOriginRequestAllowed({
          origin: "https://APP.Example.COM",
          host: "app.example.com",
        }),
      ).toBe(true);
    });

    it("rejects a lookalike host rather than testing a prefix", () => {
      expect(
        isOriginRequestAllowed({
          origin: "https://app.example.com.evil.com",
          host: HOST,
        }),
      ).toBe(false);
    });

    it("fails closed when the Host header is absent", () => {
      // There is no forwarded-header fallback: a header the client may influence
      // must never answer "which host am I?". This is what makes the absence of
      // a `trustProxy` option safe rather than merely convenient.
      expect(
        isOriginRequestAllowed({ origin: SELF, host: undefined }),
      ).toBe(false);
    });

    it("rejects `Origin: null`, which never names a host", () => {
      expect(
        isOriginRequestAllowed({
          origin: "null",
          site: "same-origin",
          host: HOST,
        }),
      ).toBe(false);
    });
  });

  describe("explicit allowlist", () => {
    it("matches a listed origin exactly", () => {
      expect(
        isOriginRequestAllowed({
          allowed: ALLOW,
          origin: "https://admin.example.com",
          host: HOST,
        }),
      ).toBe(true);
    });

    it("rejects an unlisted origin", () => {
      expect(
        isOriginRequestAllowed({
          allowed: ALLOW,
          origin: "https://evil.com",
          host: HOST,
        }),
      ).toBe(false);
    });

    it('widens "self" instead of replacing it', () => {
      // Naming an extra origin must never lock the operator out of their own
      // site — the allowlist is additive.
      expect(
        isOriginRequestAllowed({ allowed: ALLOW, origin: SELF, host: HOST }),
      ).toBe(true);
    });

    it("widens for a single string too, since it is a one-element list", () => {
      expect(
        isOriginRequestAllowed({
          allowed: "https://example.com",
          origin: SELF,
          host: HOST,
        }),
      ).toBe(true);
      expect(
        isOriginRequestAllowed({
          allowed: "https://example.com",
          origin: "https://example.com",
          host: HOST,
        }),
      ).toBe(true);
      expect(
        isOriginRequestAllowed({
          allowed: "https://example.com",
          origin: "https://evil.com",
          host: HOST,
        }),
      ).toBe(false);
    });
  });

  describe("fallback once Origin is gone", () => {
    const site = (value: string) =>
      isOriginRequestAllowed({
        allowed: ALLOW,
        origin: undefined,
        site: value,
        host: HOST,
      });

    it("admits same-origin and none", () => {
      expect(site("same-origin")).toBe(true);
      expect(site("none")).toBe(true);
    });

    it("rejects same-site, cross-site, and an unrecognised value", () => {
      // A stripped Origin plus a coarse enum cannot name a host, so the check
      // fails closed instead of degrading to a no-op.
      expect(site("same-site")).toBe(false);
      expect(site("cross-site")).toBe(false);
      expect(site("bogus")).toBe(false);
    });
  });

  describe("headerless clients", () => {
    it("rejects by default and admits when opted in", () => {
      expect(isOriginRequestAllowed({ allowed: ALLOW, host: HOST })).toBe(
        false,
      );
      expect(
        isOriginRequestAllowed({
          allowed: ALLOW,
          host: HOST,
          allowHeaderless: true,
        }),
      ).toBe(true);
    });

    it("does not weaken the check for requests that do carry an Origin", () => {
      expect(
        isOriginRequestAllowed({
          allowed: ALLOW,
          origin: "https://evil.com",
          host: HOST,
          allowHeaderless: true,
        }),
      ).toBe(false);
    });
  });

  it("treats an empty or whitespace-only header value as absent", () => {
    // Adapters disagree on what a missing header yields — Node gives
    // `undefined`, Hono's `c.req.header()` may give `""` — so the helper
    // normalises rather than letting each adapter pick a convention.
    expect(
      isOriginRequestAllowed({
        allowed: ALLOW,
        origin: "  ",
        site: "",
        host: HOST,
      }),
    ).toBe(false);
    expect(
      isOriginRequestAllowed({
        allowed: ALLOW,
        origin: "",
        site: "  ",
        host: HOST,
        allowHeaderless: true,
      }),
    ).toBe(true);
  });

  it("sibling subdomain survives: allowlisted Origin + same-site passes", () => {
    // Regression for the tier ordering. `Sec-Fetch-Site` alone would reject this
    // as `same-site`; only because `Origin` is consulted first does the
    // allowlist get to admit a sibling domain.
    expect(
      isOriginRequestAllowed({
        allowed: ALLOW,
        origin: "https://admin.example.com",
        site: "same-site",
        host: HOST,
      }),
    ).toBe(true);
  });

  it("an allowlisted Origin wins over a contradicting Sec-Fetch-Site", () => {
    // Tier order made explicit: `Origin` is consulted first and short-circuits,
    // so an allowlisted origin is trusted even when the coarse enum says
    // `cross-site`. The allowlist is the operator's explicit statement about
    // which origins are trusted, and a four-value enum cannot name a host — so
    // letting it override the allowlist would re-break the sibling-subdomain
    // case above. Worth pinning because the alternative is defensible on paper.
    expect(
      isOriginRequestAllowed({
        allowed: ALLOW,
        origin: "https://admin.example.com",
        site: "cross-site",
        host: HOST,
      }),
    ).toBe(true);
  });
});

describe("formatError", () => {
  it("should return generic error in production", () => {
    expect(formatError(new Error("secret"), true)).toEqual({
      error: "Internal Server Error",
    });
  });

  it("should not leak exception message in dev", () => {
    expect(formatError(new Error("secret"), false)).toEqual({
      error: "Internal Server Error",
    });
  });

  it("should include code and data for RPCError in dev", () => {
    expect(
      formatError(
        new RPCError("validation failed", "VALIDATION", { field: "x" }),
        false,
      ),
    ).toEqual({
      error: "validation failed",
      code: "VALIDATION",
      data: { field: "x" },
    });
  });

  it("should keep code for RPCError but drop data in production", () => {
    expect(
      formatError(
        new RPCError("validation failed", "VALIDATION", { field: "x" }),
        true,
      ),
    ).toEqual({ error: "Internal Server Error" });
  });

  it("should default code to INTERNAL for RPCError", () => {
    expect(formatError(new RPCError("boom"), false)).toEqual({
      error: "boom",
      code: "INTERNAL",
    });
  });

  it("should return generic error for non-Error values in dev", () => {
    expect(formatError("string failure", false)).toEqual({
      error: "Internal Server Error",
    });
  });

  it("should fall back to generic error for empty RPCError message in dev", () => {
    expect(formatError(new RPCError(""), false)).toEqual({
      error: "Internal Server Error",
      code: "INTERNAL",
    });
  });
});

describe("safeURL", () => {
  it("should parse a well-formed path", () => {
    expect(safeURL("/__rpc/foo?x=1").pathname).toBe("/__rpc/foo");
  });

  it("should fall back to the base root for a malformed request-target instead of throwing", () => {
    expect(() => safeURL("/\\")).not.toThrow();
    expect(safeURL("/\\").pathname).toBe("/");
    expect(() => safeURL("//")).not.toThrow();
    expect(safeURL("//").pathname).toBe("/");
    expect(() => safeURL("/\\/")).not.toThrow();
    expect(safeURL("/\\/").pathname).toBe("/");
  });

  it("should respect a custom base", () => {
    expect(safeURL("/\\", "https://example.com").pathname).toBe("/");
  });
});

describe("walkGlobFiles", () => {
  it("should find *.server.* files recursively and ignore others", async () => {
    const files = await walkGlobFiles(
      `${import.meta.dirname}/fixtures/glob-recursive/api`,
    );
    const names = files.map((f) => f.split("/").pop()).sort();
    expect(names).toEqual(["a.server.ts", "b.server.ts"]);
  });

  it("should return an empty array for a missing directory", async () => {
    expect(await walkGlobFiles("/nonexistent/definitely-missing")).toEqual([]);
  });
});

describe("isFormContentType", () => {
  it("should recognize multipart/form-data", () => {
    expect(isFormContentType("multipart/form-data")).toBe(true);
  });

  it("should recognize application/x-www-form-urlencoded", () => {
    expect(isFormContentType("application/x-www-form-urlencoded")).toBe(true);
  });

  it("should reject json and text", () => {
    expect(isFormContentType("application/json")).toBe(false);
    expect(isFormContentType("text/plain")).toBe(false);
  });
});

describe("hasContentTypeMismatch", () => {
  it("should match json declared against json header", () => {
    expect(
      hasContentTypeMismatch("application/json", "application/json"),
    ).toBe(false);
  });

  it("should reject json declared against urlencoded header", () => {
    expect(
      hasContentTypeMismatch(
        "application/json",
        "application/x-www-form-urlencoded",
      ),
    ).toBe(true);
  });

  it("should reject text declared against json header", () => {
    expect(
      hasContentTypeMismatch("text/plain", "application/json"),
    ).toBe(true);
  });

  it("should strip boundary/charset parameters before comparing", () => {
    expect(
      hasContentTypeMismatch(
        "multipart/form-data",
        "multipart/form-data; boundary=----xyz",
      ),
    ).toBe(false);
    expect(
      hasContentTypeMismatch(
        "application/json",
        "application/json; charset=utf-8",
      ),
    ).toBe(false);
  });

  it("should be lenient between the two forms", () => {
    expect(
      hasContentTypeMismatch(
        "multipart/form-data",
        "application/x-www-form-urlencoded",
      ),
    ).toBe(false);
    expect(
      hasContentTypeMismatch(
        "application/x-www-form-urlencoded",
        "multipart/form-data",
      ),
    ).toBe(false);
  });

  it("should reject a form-declared function that gets json", () => {
    expect(
      hasContentTypeMismatch("multipart/form-data", "application/json"),
    ).toBe(true);
  });

  it("should exempt requests without a Content-Type header", () => {
    expect(hasContentTypeMismatch("application/json", undefined)).toBe(false);
    expect(hasContentTypeMismatch("multipart/form-data", "")).toBe(false);
  });

  it("should be case-insensitive", () => {
    expect(
      hasContentTypeMismatch("application/json", "APPLICATION/JSON"),
    ).toBe(false);
  });
});

/* ─── Typed error subclasses ───────────────────────────────────────────────
 * These shipped on a claim of "verified" that came from a throwaway script, so
 * every part of the contract is asserted here instead.
 */

describe("typed error subclasses", () => {
  const cases = [
    ["NotFoundError", NotFoundError, 404, "NOT_FOUND"],
    ["ForbiddenError", ForbiddenError, 403, "FORBIDDEN"],
    ["ConflictError", ConflictError, 409, "CONFLICT"],
  ] as const;

  for (const [name, Ctor, status, code] of cases) {
    describe(name, () => {
      it("carries the client-error status, so the adapter answers it directly", () => {
        expect(new Ctor("nope", "do the thing").status).toBe(status);
      });

      it("uses the class name and a stable code", () => {
        const err = new Ctor("nope", "do the thing");
        expect(err.name).toBe(name);
        expect(err.code).toBe(code);
        expect(err instanceof RPCError).toBe(true);
      });

      it("requires a hint, so a teaching class cannot be built without the teaching", () => {
        // Compile-time enforcement; asserted here only so the intent is recorded.
        expect(new Ctor("nope", "do the thing").hint).toBe("do the thing");
      });

      it("is recognised as a client error, not a server fault", () => {
        expect(isClientHttpError(new Ctor("nope", "hint"))).toBe(true);
        expect(clientErrorStatus(new Ctor("nope", "hint"))).toBe(status);
      });

      it("keeps message, code, data and hint in development", () => {
        const body = formatError(
          new Ctor("no such user", "check the id", { id: 7 }),
          false,
        );
        expect(body).toEqual({
          error: "no such user",
          code,
          data: { id: 7 },
          hint: "check the id",
        });
      });

      it("strips everything but the status reason phrase in production", () => {
        // A thrown error used to be answered with the right status and the body
        // `{ error: "Bad Request" }` — right status, wrong meaning, and the
        // author's code and hint discarded.
        expect(
          formatError(
            new Ctor("no such user", "check the id", { id: 7 }),
            true,
          ),
        )
          .toEqual({ error: clientErrorMessage(status) });
      });
    });
  }

  it("omits the hint key when a thrown 4xx carries none", () => {
    // A bare `RPCError` with a 4xx status: the body must not grow an empty
    // `hint`, or every thrown client error changes shape for no reason.
    const bare = new RPCError("gone", "GONE");
    (bare as unknown as { status: number }).status = 410;
    expect("hint" in formatError(bare, false)).toBe(false);
  });

  it("falls back to the reason phrase when a thrown error has an empty message", () => {
    expect(formatError(new NotFoundError("", "hint"), false)).toMatchObject({
      error: "Not Found",
    });
  });
});

describe("RPCError.hint", () => {
  it("is optional and absent by default", () => {
    expect(new RPCError("boom").hint).toBeUndefined();
  });

  it("is carried through formatError in development", () => {
    expect(
      formatError(new RPCError("boom", "X", { a: 1 }, "retry later"), false),
    )
      .toEqual({
        error: "boom",
        code: "X",
        data: { a: 1 },
        hint: "retry later",
      });
  });

  it("is stripped in production, like code and data", () => {
    expect(
      formatError(new RPCError("boom", "X", { a: 1 }, "retry later"), true),
    )
      .toEqual({ error: "Internal Server Error" });
  });

  it("does not add a hint key when there is no hint", () => {
    expect("hint" in formatError(new RPCError("boom"), false)).toBe(false);
  });
});

describe("isRPCError", () => {
  it("recognises an RPCError and its subclasses", () => {
    expect(isRPCError(new RPCError("x"))).toBe(true);
    expect(isRPCError(new NotFoundError("x", "h"))).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isRPCError(new Error("x"))).toBe(false);
    expect(isRPCError(null)).toBe(false);
    expect(isRPCError("x")).toBe(false);
    expect(isRPCError({ code: "X" })).toBe(false);
  });

  it("survives the per-entry duplication tsdown produces", () => {
    // Each build entry bundles its own copy of the class, so a ValidationError
    // raised by `runValidation` inside dist/server is not `instanceof` the
    // RPCError in dist/express. That silently answered `false` and made every
    // execution record claim `isRPCError: false` — which is why the brand is a
    // registered symbol rather than `instanceof` alone.
    const branded = {
      [Symbol.for("thednp.rpc.error")]: true,
      code: "VALIDATION",
      name: "ValidationError",
    };
    expect(new RPCError("x") instanceof RPCError).toBe(true);
    expect(isRPCError(branded)).toBe(true);
  });
});

describe("describeOriginRequest", () => {
  it("reports tier 1 when Origin decides", () => {
    expect(
      describeOriginRequest({ origin: "https://app.test", host: "app.test" }),
    ).toEqual({ allowed: true, tier: "origin" });
  });

  it("reports tier 1 on a rejected Origin too", () => {
    expect(
      describeOriginRequest({ origin: "https://evil.test", host: "app.test" }),
    ).toEqual({ allowed: false, tier: "origin" });
  });

  it("reports tier 2 when only Sec-Fetch-Site survives", () => {
    expect(describeOriginRequest({ site: "same-origin" })).toEqual({
      allowed: true,
      tier: "sec-fetch-site",
    });
    expect(describeOriginRequest({ site: "cross-site" })).toEqual({
      allowed: false,
      tier: "blocked",
    });
  });

  it("reports tier 3 only when headerless is allowed", () => {
    expect(describeOriginRequest({ allowHeaderless: true })).toEqual({
      allowed: true,
      tier: "headerless",
    });
    expect(describeOriginRequest({})).toEqual({
      allowed: false,
      tier: "blocked",
    });
  });

  it("never disagrees with isOriginRequestAllowed, which it is defined in terms of", () => {
    const inputs = [
      { origin: "https://app.test", host: "app.test" },
      { origin: "https://evil.test", host: "app.test" },
      { site: "none" },
      { site: "cross-site" },
      { allowHeaderless: true },
      {},
      { origin: "   " },
    ];
    for (const input of inputs) {
      expect(isOriginRequestAllowed(input)).toBe(
        describeOriginRequest(input).allowed,
      );
    }
  });
});
