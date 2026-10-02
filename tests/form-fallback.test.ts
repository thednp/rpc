import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  decodeFormFlash,
  encodeFormFlash,
  FLASH_LIMIT,
  FLASH_PARAM,
  flashFromError,
  flashRedirectUrl,
  formFallbackLocation,
  formSuccessLocation,
  isNativeFormNavigation,
  pickReplayable,
  resolveFallback,
  sanitizeRedirect,
} from "../src/form-fallback.ts";
import type { FormFallbackOutcome, ValidationIssue } from "../src/types.d.ts";
import {
  ConflictError,
  NotFoundError,
  RPCError,
  ValidationError,
} from "../src/server-helpers.ts";

const BASE = "https://app.example.com/contact?page=2";

// The codec is imported by browser code (the demo's `hydrate.ts` rehydrates a
// flash), so "server-only" must be a property of the *other* module. If this
// regresses, the failure is a bundler error in someone's app rather than a test
// failure here, which is the worst place to find out.
describe("the flash codec is client-safe", () => {
  it("imports nothing outside itself", async () => {
    const source = await readFile(
      new URL("../src/form-flash.ts", import.meta.url),
      "utf8",
    );
    const imports = [...source.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) =>
      m[1]
    );
    expect(imports).toEqual([]);
  });

  it("round-trips a flash, so a browser can read what a server wrote", () => {
    const flash = {
      errors: { age: ["expected a number"] },
      message: "check it",
    };
    expect(decodeFormFlash(encodeFormFlash(flash))).toEqual(flash);
  });

  it("is re-exported from the server entry, so existing imports keep working", async () => {
    const server = await readFile(
      new URL("../src/server.ts", import.meta.url),
      "utf8",
    );
    expect(server).toContain("form-fallback.ts");
  });
});

describe("isNativeFormNavigation", () => {
  /**
   * The discriminator is `Accept`, and this table is the record of why. Both
   * clients below post a *form content type* to the same form-declared function
   * — the native form sends urlencoded, the generated stub sends multipart — so
   * a check keyed on content type alone would hand the browser-side caller a
   * redirect where it expects a rejection.
   */
  const form = {
    contentType: "application/x-www-form-urlencoded",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };

  it("matches a native form navigation", () => {
    expect(isNativeFormNavigation({ ...form, method: "POST" })).toBe(true);
  });

  it("matches a multipart form navigation", () => {
    // A native `<form enctype="multipart/form-data">` is a real navigation, and
    // the file-upload case is the reason that content type exists. The `Accept`
    // gate is what keeps `fetch` out, not the encoding.
    expect(
      isNativeFormNavigation({
        method: "POST",
        contentType: "multipart/form-data; boundary=----abc",
        accept: "text/html",
      }),
    ).toBe(true);
  });

  it("does not match the generated client stub, which posts multipart", () => {
    // The failure this guards: a `fetch` from the stub sends a wildcard Accept,
    // so it must fall through to the RPC dispatch and keep rejecting normally.
    expect(
      isNativeFormNavigation({
        method: "POST",
        contentType: "multipart/form-data; boundary=----abc",
        accept: "*/*",
      }),
    ).toBe(false);
  });

  it("does not match a form content type without a navigation Accept", () => {
    // Content type alone must never be enough, in either encoding.
    expect(
      isNativeFormNavigation({
        method: "POST",
        contentType: "multipart/form-data",
        accept: "*/*",
      }),
    ).toBe(false);
    expect(
      isNativeFormNavigation({
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
      }),
    ).toBe(false);
  });

  it("lets fetch metadata override an Accept that claims otherwise", () => {
    // Where the headers are present they are more precise than `Accept`, so a
    // navigation that somehow sends a wildcard Accept is still matched...
    expect(
      isNativeFormNavigation({
        method: "POST",
        contentType: "multipart/form-data",
        accept: "*/*",
        secFetchDest: "document",
        secFetchMode: "navigate",
      }),
    ).toBe(true);
    // ...and a fetch that asks for HTML is still not one. This is the false
    // positive the `Accept`-only rule cannot catch.
    expect(
      isNativeFormNavigation({
        ...form,
        method: "POST",
        secFetchDest: "empty",
        secFetchMode: "cors",
      }),
    ).toBe(false);
    expect(
      isNativeFormNavigation({ ...form, method: "POST", secFetchMode: "cors" }),
    ).toBe(false);
  });

  it("treats absent fetch metadata as no opinion, not as disagreement", () => {
    // A client that sends neither header is judged on `Accept` alone, so a
    // curl-style submission is not excluded twice over.
    expect(isNativeFormNavigation({ ...form, method: "POST" })).toBe(true);
  });

  it("does not match a non-POST method", () => {
    for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      expect(isNativeFormNavigation({ ...form, method })).toBe(false);
    }
  });

  it("matches the method case-insensitively", () => {
    expect(isNativeFormNavigation({ ...form, method: "post" })).toBe(true);
  });

  it("does not match a navigation Accept with a non-form content type", () => {
    // An `Accept: text/html` fetch of a JSON endpoint is not a form submission,
    // and must not be diverted into the form path.
    for (
      const contentType of [
        "application/json",
        "text/plain",
        "application/json; charset=utf-8",
      ]
    ) {
      expect(
        isNativeFormNavigation({
          method: "POST",
          contentType,
          accept: "text/html",
        }),
      ).toBe(false);
    }
  });

  it("is case-insensitive about the Accept value", () => {
    expect(
      isNativeFormNavigation({
        ...form,
        method: "POST",
        accept: "TEXT/HTML,application/xhtml+xml",
      }),
    ).toBe(true);
  });

  it("treats missing headers as absent, not as a match", () => {
    expect(isNativeFormNavigation({ method: "POST" })).toBe(false);
    expect(isNativeFormNavigation({})).toBe(false);
    expect(isNativeFormNavigation({ method: "POST", accept: "text/html" }))
      .toBe(
        false,
      );
  });
});

describe("sanitizeRedirect", () => {
  /**
   * An allowlist of shape rather than a denylist of schemes. Every rejected row
   * here is a way to reach somewhere other than this origin.
   */
  const rejected: [label: string, target: string][] = [
    ["a javascript: URL", "javascript:alert(1)"],
    ["a javascript: URL with leading space", "  javascript:alert(1)"],
    ["a mixed-case javascript: URL", "JaVaScRiPt:alert(1)"],
    ["a data: URL", "data:text/html,<script>alert(1)</script>"],
    ["a vbscript: URL", "vbscript:msgbox(1)"],
    ["a protocol-relative host", "//evil.test/path"],
    ["an absolute URL to another host", "https://evil.test/path"],
    ["an absolute URL to this host", "https://app.example.com/other"],
    ["a backslash-obfuscated protocol-relative host", "/\\evil.test"],
    ["a relative path", "other/page"],
    [
      "a same-origin absolute URL, which is refused not rewritten",
      "https://app.example.com/thanks",
    ],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a newline, which can split the response header", "/ok\r\nX-Injected: 1"],
    ["a tab, which can obfuscate a scheme", "java\tscript:alert(1)"],
    ["a NUL byte", "/ok\u0000"],
  ];

  for (const [label, target] of rejected) {
    it(`falls back to "/" for ${label}`, () => {
      expect(sanitizeRedirect(target, BASE)).toBe("/");
    });
  }

  it('falls back to "/" for a non-string target', () => {
    expect(sanitizeRedirect(undefined, BASE)).toBe("/");
    expect(sanitizeRedirect(null, BASE)).toBe("/");
  });

  it("keeps a same-origin absolute path, with query and fragment", () => {
    expect(sanitizeRedirect("/thanks?ref=form#top", BASE)).toBe(
      "/thanks?ref=form#top",
    );
  });

  it("keeps a bare root path", () => {
    expect(sanitizeRedirect("/", BASE)).toBe("/");
  });

  it("rejects a same-origin absolute URL rather than rewriting it", () => {
    // Deliberately stricter than necessary. The rule is a shape allowlist — a
    // root-relative path — so an absolute URL is refused, not quietly reduced
    // to its path. Silently rewriting an author's target would make the failure
    // harder to diagnose than refusing it, and "the browser is never handed a
    // full URL to re-parse" is not worth an extra parse-and-compare path.
    expect(sanitizeRedirect("https://app.example.com/thanks", BASE)).toBe("/");
  });

  it("allows a double slash inside the query, unlike a blanket substring check", () => {
    // `//` is only dangerous at the start of a target, where it makes a
    // protocol-relative reference to another host. Inside a query string it is
    // ordinary data — a `next=` parameter, a URL passed through — so rejecting
    // every string containing `//` would be over-strict and would silently turn
    // a legitimate target into `/`. The origin comparison decides safety.
    expect(sanitizeRedirect("/next?url=https://x.test//a//b", BASE)).toBe(
      "/next?url=https://x.test//a//b",
    );
  });

  it("rejects a protocol-relative target through the origin check", () => {
    // Documents where the safety comes from: `new URL("//evil.test", base)`
    // resolves cross-origin, so the comparison rejects it. That is why a `//` in
    // the query above is harmless while one at the start is not.
    expect(sanitizeRedirect("//evil.test/path", BASE)).toBe("/");
  });

  it("falls back when the base itself cannot be parsed", () => {
    // Without a parseable base there is no origin to vouch against, so the
    // target cannot be trusted either — not even an obvious relative one.
    expect(sanitizeRedirect("/thanks", "not a url")).toBe("/");
  });

  it("preserves the fragment, which the author usually wants for scrolling", () => {
    expect(sanitizeRedirect("/?errors=email#contact", BASE)).toBe(
      "/?errors=email#contact",
    );
  });
});

describe("flashFromError", () => {
  /**
   * The convention rpc owns. The case that matters most is the last one: an
   * unexpected exception must stay a 500 rather than becoming a friendly
   * redirect, because flashifying it would both hide the fault and write its
   * message into a URL.
   */
  it("groups a validation failure's issues by path", () => {
    const flash = flashFromError(
      new ValidationError([
        { path: "email", message: "expected a string" },
        { path: "email", message: "not a known domain" },
        { path: "age", message: "too small" },
      ]),
    );
    expect(flash?.errors).toEqual({
      email: ["expected a string", "not a known domain"],
      age: ["too small"],
    });
  });

  it("falls back to the hint for a field with no message", () => {
    const flash = flashFromError(
      new ValidationError([{
        path: "email",
        hint: "use the .optional() form",
      }]),
    );
    expect(flash?.errors).toEqual({ email: ["use the .optional() form"] });
  });

  it("skips an issue carrying neither a message nor a hint", () => {
    const flash = flashFromError(new ValidationError([{ path: "email" }]));
    expect(flash?.errors).toEqual({});
  });

  it("files a pathless issue under the root key", () => {
    // The Standard Schema spec allows an issue with no path, and a foreign
    // validator can produce one — so `path` can be `undefined` at runtime even
    // though rpc's own type requires it. It must not throw, and it must land
    // somewhere the re-rendered form can render, which is the root.
    const err = new ValidationError([
      { message: "the whole payload is wrong" } as unknown as ValidationIssue,
    ]);
    expect(flashFromError(err)?.errors).toEqual({
      "": ["the whole payload is wrong"],
    });
  });

  it("prefers the author-written hint over the message", () => {
    const flash = flashFromError(
      new RPCError(
        "user not found",
        "NOT_FOUND",
        undefined,
        "ids look like u-42",
      ),
    );
    expect(flash?.message).toBe("ids look like u-42");
    expect(flash?.errors).toBeUndefined();
  });

  it("falls back to the message when a thrown error has no hint", () => {
    expect(flashFromError(new RPCError("Invalid credentials"))?.message).toBe(
      "Invalid credentials",
    );
  });

  it("works across the typed subclasses", () => {
    expect(
      flashFromError(new NotFoundError("no such user", "ids look like u-42"))
        ?.message,
    ).toBe("ids look like u-42");
    expect(flashFromError(new ConflictError("taken", "pick another"))?.message)
      .toBe("pick another");
  });

  it("refuses an unexpected exception, so it stays a 500", () => {
    expect(flashFromError(new Error("connection string leaked here")))
      .toBeNull();
    expect(flashFromError(new TypeError("x is not a function"))).toBeNull();
    expect(flashFromError("a string")).toBeNull();
    expect(flashFromError(undefined)).toBeNull();
  });
});

describe("pickReplayable", () => {
  const fields = {
    email: "a@b.co",
    age: "36",
    subscribe: true,
    name: { first: "Ada" },
    token: "secret-token",
    file: new File(["x"], "a.txt"),
  };

  it("returns nothing by default, so nothing leaks unless asked for", () => {
    expect(pickReplayable(fields)).toEqual({});
    expect(pickReplayable(fields, [])).toEqual({});
  });

  it("keeps only the named fields", () => {
    expect(pickReplayable(fields, ["email", "subscribe"])).toEqual({
      email: "a@b.co",
      subscribe: true,
    });
  });

  it("never replays a field the author did not name, however secret-looking", () => {
    // `token` is in the fixture precisely to prove the allowlist is the only
    // thing that decides. An author who names it has made a mistake, but the
    // default is the safe side of that.
    expect(pickReplayable(fields, ["email"])).not.toHaveProperty("token");
  });

  it("drops non-primitive values, which would serialise to nothing useful", () => {
    // `name` is an object and `file` is a `File`. Both would become `[object
    // Object]` and an empty string in the URL, so both look like data the author
    // chose to replay when they did not.
    const picked = pickReplayable(fields, ["email", "name", "file"]);
    expect(picked).toEqual({ email: "a@b.co" });
  });

  it("keeps a string, which is a primitive even when it looks like a path", () => {
    // The rule is the value's type, not its name — a field called `file` holding
    // a string is as replayable as one called `email`.
    expect(pickReplayable({ note: "hello" }, ["note"])).toEqual({
      note: "hello",
    });
  });

  it("ignores names that are not present", () => {
    expect(pickReplayable(fields, ["email", "absent"])).toEqual({
      email: "a@b.co",
    });
  });
});

describe("resolveFallback", () => {
  it("leaves an unset fallback unset", () => {
    expect(resolveFallback(undefined)).toBeUndefined();
  });

  it("treats a bare string as a path that replays nothing", () => {
    expect(resolveFallback("/?#contact")).toEqual({
      to: "/?#contact",
      replay: [],
    });
  });

  it("defaults replay to empty when the object omits it", () => {
    expect(resolveFallback({ to: "/?#contact" })).toEqual({
      to: "/?#contact",
      replay: [],
    });
  });

  it("keeps an authored function as the target", () => {
    const to = (o: FormFallbackOutcome) =>
      o.status === "ok" ? "/thanks" : "/?#x";
    expect(resolveFallback({ to })?.to).toBe(to);
  });

  it("copies replay, so a later push cannot widen the policy", () => {
    // The array is read at dispatch time, on every request, from the author's own
    // object. Mutating it after registration would otherwise change the replay
    // set of a function already serving traffic.
    const replay = ["email"];
    const resolved = resolveFallback({ to: "/", replay })!;
    replay.push("password");
    expect(resolved.replay).toEqual(["email"]);
  });

  it("freezes the copy, so a later write fails loudly", () => {
    const resolved = resolveFallback({ to: "/", replay: ["email"] })!;
    expect(Object.isFrozen(resolved.replay)).toBe(true);
  });

  it("rejects a target that is neither a string nor a function", () => {
    expect(() => resolveFallback({ to: 42 as unknown as string })).toThrow(
      /must be a string path or a function/,
    );
  });
});

const NAV = {
  method: "POST",
  contentType: "application/x-www-form-urlencoded",
  accept: "text/html",
};

describe("formFallbackLocation", () => {
  const opts = { fallback: "/contact" } as const;

  it("redirects a rejected navigation with the failure flashed", () => {
    const loc = formFallbackLocation(
      new NotFoundError("no such user", "try another id"),
      opts.fallback,
      { age: "x" },
      NAV,
    )!;
    expect(loc.startsWith("/contact?")).toBe(true);
    expect(
      decodeFormFlash(
        new URLSearchParams(loc.slice(loc.indexOf("?") + 1)).get(FLASH_PARAM)!,
      )?.message,
    )
      .toBe("try another id");
  });

  it("returns undefined when no fallback is configured", () => {
    expect(
      formFallbackLocation(
        new NotFoundError("x", "try another id"),
        undefined,
        {},
        NAV,
      ),
    )
      .toBeUndefined();
  });

  it("returns undefined for a request that is not a navigation", () => {
    const err = new NotFoundError("x", "try another id");
    expect(
      formFallbackLocation(err, opts.fallback, {}, {
        ...NAV,
        accept: "application/json",
      }),
    )
      .toBeUndefined();
  });

  // A stack trace must never end up in a `Location`, and a real fault must stay
  // a 500 rather than becoming a cheerful redirect.
  it("returns undefined for an error that is not client-facing", () => {
    expect(formFallbackLocation(new Error("boom"), opts.fallback, {}, NAV))
      .toBeUndefined();
  });

  it("returns undefined when the author's chooser throws", () => {
    const loc = formFallbackLocation(
      new NotFoundError("x", "try another id"),
      {
        to: () => {
          throw new Error("chooser exploded");
        },
      },
      {},
      NAV,
    );
    expect(loc).toBeUndefined();
  });

  it("returns undefined when the chooser returns a non-string", () => {
    const loc = formFallbackLocation(
      new NotFoundError("x", "try another id"),
      { to: (() => 42) as unknown as () => string },
      {},
      NAV,
    );
    expect(loc).toBeUndefined();
  });

  // An unsafe target still redirects, to the sanitiser's same-origin fallback —
  // serving raw JSON to a no-JS user would be the worse outcome.
  it("degrades an unsafe target to the sanitiser's own fallback", () => {
    const loc = formFallbackLocation(
      new NotFoundError("x", "try another id"),
      { to: "//evil.test/steal" },
      {},
      NAV,
    )!;
    const url = new URL(loc, "http://localhost");
    expect(url.host).toBe("localhost");
    expect(decodeFormFlash(url.searchParams.get(FLASH_PARAM)!)).not.toBeNull();
  });

  it("attaches replayed values only for the fields the author named", () => {
    const loc = formFallbackLocation(
      new NotFoundError("x", "try another id"),
      { to: "/contact", replay: ["note"] },
      { note: "hello", password: "hunter2" },
      NAV,
    )!;
    expect(
      decodeFormFlash(
        new URLSearchParams(loc.slice(loc.indexOf("?") + 1)).get(FLASH_PARAM)!,
      )?.values,
    )
      .toEqual({ note: "hello" });
    expect(loc).not.toContain("hunter2");
  });
});

describe("formSuccessLocation", () => {
  const NAV = {
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    accept: "text/html",
  };

  it("redirects a successful navigation with no flash at all", () => {
    expect(formSuccessLocation("/thanks", {}, NAV)).toBe("/thanks");
  });

  it("returns undefined for a request that is not a navigation", () => {
    expect(
      formSuccessLocation("/thanks", {}, {
        ...NAV,
        accept: "application/json",
      }),
    )
      .toBeUndefined();
  });

  it("lets the chooser branch on the outcome", () => {
    const to = (
      o: FormFallbackOutcome,
    ) => (o.status === "ok" ? "/thanks" : "/contact");
    expect(formSuccessLocation({ to }, {}, NAV)).toBe("/thanks");
  });

  it("replays named values on success when the author asks for it", () => {
    const loc = formSuccessLocation(
      { to: "/thanks", replay: ["email"] },
      { email: "a@b.c", secret: "x" },
      NAV,
    )!;
    expect(
      decodeFormFlash(
        new URLSearchParams(loc.slice(loc.indexOf("?") + 1)).get(FLASH_PARAM)!,
      )?.values,
    )
      .toEqual({ email: "a@b.c" });
    expect(loc).not.toContain("secret");
  });
});

describe("pickReplayable", () => {
  it("reads nothing from a non-object submission", () => {
    // A form body can arrive as anything the client sent, and `multipart` bodies
    // are handed over as `{ raw }` rather than parsed fields — so `pickReplayable`
    // has to treat a primitive as "no own keys", not as a crash.
    expect(pickReplayable("a string", ["x"])).toEqual({});
    expect(pickReplayable(null, ["x"])).toEqual({});
    expect(pickReplayable(undefined, ["x"])).toEqual({});
    expect(pickReplayable(42, ["x"])).toEqual({});
  });
});

describe("flash encoding", () => {
  it("round-trips a flash", () => {
    const flash = {
      errors: { email: ["expected a string"] },
      values: { email: "a@b.co" },
      message: "check the form",
    };
    expect(decodeFormFlash(encodeFormFlash(flash))).toEqual(flash);
  });

  it("drops a flash that would exceed the size bound", () => {
    // Dropped rather than truncated: a partial issue list would show the user
    // some errors and hide others, which is worse than none.
    const huge = { message: "x".repeat(FLASH_LIMIT + 1) };
    expect(encodeFormFlash(huge)).toBeNull();
  });

  it("keeps the bound under a proxy's request-line ceiling", () => {
    // The flash URL is fetched by the browser, so it is a request line. nginx's
    // default `large_client_header_buffers 4 8k` caps that at 8 KiB, so a flash
    // bound above ~4 KiB risks a 414 instead of a re-rendered form.
    expect(FLASH_LIMIT).toBeLessThanOrEqual(4096);
    // …while still fitting a realistic payload: twenty fields with hints.
    const realistic = {
      errors: Object.fromEntries(
        Array.from(
          { length: 20 },
          (_, i) => [`field${i}`, ["a reasonably long validation message"]],
        ),
      ),
      message: "please review the highlighted fields",
    };
    expect(encodeFormFlash(realistic)).not.toBeNull();
  });

  it("returns null rather than throwing on a malformed payload", () => {
    // This runs during a page render, so a bad query parameter must not be the
    // reason the page fails.
    expect(decodeFormFlash("{not json")).toBeNull();
    expect(decodeFormFlash("null")).toBeNull();
    expect(decodeFormFlash("42")).toBeNull();
    expect(decodeFormFlash("")).toBeNull();
    expect(decodeFormFlash(undefined)).toBeNull();
  });

  it("rejects structurally invalid flash containers", () => {
    expect(decodeFormFlash("[]")).toBeNull();
    expect(decodeFormFlash('{"errors":"email"}')).toBeNull();
    expect(decodeFormFlash('{"errors":{"email":"bad"}}')).toBeNull();
    expect(decodeFormFlash('{"errors":{"email":[123]}}')).toBeNull();
    expect(decodeFormFlash('{"values":[]}')).toBeNull();
    expect(decodeFormFlash('{"message":123}')).toBeNull();
  });

  it("measures the flash bound in URL bytes, not string units", () => {
    // A multibyte payload can exceed the byte ceiling while staying under
    // `String.length`; the cap must cover the request line, not UTF-16 storage.
    const bytes = new TextEncoder().encode(
      JSON.stringify({ message: "é".repeat(FLASH_LIMIT) }),
    ).length;
    expect(bytes).toBeGreaterThan(FLASH_LIMIT);
    expect(encodeFormFlash({ message: "é".repeat(FLASH_LIMIT) })).toBeNull();
  });

  it("carries a flash in the query string on the redirect target", () => {
    const url = flashRedirectUrl(
      "/?x=1#contact",
      { errors: { email: ["bad"] } },
      BASE,
    );
    expect(url).toContain(`${FLASH_PARAM}=`);
    expect(url).toContain("email");
    expect(url).not.toContain("#contact");
  });

  it("sanitizes an untrusted target before redirecting to it", () => {
    // The target can come from a hidden field or a Referer, so the helper
    // refuses it rather than trusting the caller. The flash still rides along,
    // because it is author-written advice and opt-in values — so the user keeps
    // their errors even when the destination had to be replaced.
    const redirected = flashRedirectUrl("//evil.test/", { message: "x" }, BASE);
    expect(redirected.startsWith("/?")).toBe(true);
    expect(redirected).toContain(`${FLASH_PARAM}=`);
    expect(flashRedirectUrl("javascript:alert(1)", null, BASE)).toBe("/");
  });

  it("redirects without a flash when the payload will not fit", () => {
    expect(
      flashRedirectUrl(
        "/thanks",
        { message: "x".repeat(FLASH_LIMIT + 1) },
        BASE,
      ),
    ).toBe("/thanks");
  });
});
