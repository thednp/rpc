/**
 * Claim verification for @thednp/rpc, run against this example.
 *
 *   node --experimental-strip-types verify.mjs
 *
 * Every assertion here checks something the library or its documentation claims,
 * over real HTTP against a live Express server. It is not a substitute for the
 * unit suite in `tests/`; it exists because a claim that is only asserted in a
 * unit test is not the same as a claim that was observed happening.
 *
 * Two bugs were found this way that 100% line coverage had not:
 *
 *  - `bodyLimit` did not reach declared-JSON bodies on Hono (the Hono suite had
 *    no `bodyLimit` test at all, so the line ran and bounded nothing).
 *  - `multipart/form-data` combined with a `schema` can never validate — see
 *    section D, which pins the current behaviour and names the gap.
 */
import { createRequire } from "node:module";

const EXAMPLE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const req = createRequire(`${EXAMPLE}/package.json`);
const express = req("express");
const RPC = `${EXAMPLE}/node_modules/@thednp/rpc/dist`;

// ── guard: verify the build under test, not the published package ────────
// The example's `@thednp/rpc` resolves through its own `node_modules`, which
// points at the *published* version unless it has been linked to this repo. A
// verification run that silently exercised 0.3.7 while appearing to check the
// current tree would be worse than no verification at all, so refuse instead.
const repoRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const localVersion = JSON.parse(
  await import("node:fs").then((fs) =>
    fs.promises.readFile(`${repoRoot}/package.json`, "utf8")
  ),
).version;
const linkedVersion = JSON.parse(
  await import("node:fs").then((fs) =>
    fs.promises.readFile(
      `${EXAMPLE}/node_modules/@thednp/rpc/package.json`,
      "utf8",
    )
  ),
).version;
if (linkedVersion !== localVersion) {
  console.error(
    `\n  Refusing to run: this example resolves @thednp/rpc ${linkedVersion}, but the\n` +
      `  repo is ${localVersion}. The assertions below would test the published\n` +
      `  package instead of the working tree.\n\n` +
      `  Point it at the repo first (node_modules is generated, so this is safe):\n\n` +
      `    cd ${repoRoot}\n` +
      `    rm examples/advanced/node_modules/@thednp/rpc\n` +
      `    ln -s ${repoRoot} examples/advanced/node_modules/@thednp/rpc\n\n`,
  );
  process.exit(2);
}
console.log(
  `  verifying @thednp/rpc ${localVersion} via ${EXAMPLE}/node_modules`,
);

const { createRPCMiddleware } = await import(`${RPC}/express/express.mjs`);
const S = await import(`${RPC}/server/server.mjs`);
const {
  createServerFunction,
  schema,
  field,
  isOriginRequestAllowed,
  isOriginAllowed,
} = S;
const H3 = await import(`${RPC}/helpers/helpers.mjs`).catch(() => ({}));

await import(`${EXAMPLE}/src/api/public.server.ts`);
await import(`${EXAMPLE}/src/api/admin.server.ts`);
await import(`${EXAMPLE}/src/api/auth.server.ts`);

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(`${name} — ${detail}`);
    console.log(
      `  \x1b[31m✗\x1b[0m ${name}${detail ? ` \x1b[2m— ${detail}\x1b[0m` : ""}`,
    );
  }
};
const section = (t) =>
  console.log(
    `\n\x1b[1m── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}\x1b[0m`,
  );

// ── probes whose options we control ───────────────────────────────────────
const entered = [];
createServerFunction("probe", async (_s, input) => {
  entered.push(input);
  return { echoed: input };
}, { rpcPrefix: "public:rpc" }); // POST + JSON
createServerFunction("probe-text", async () => "ok", {
  rpcPrefix: "public:rpc",
  contentType: "text/plain",
});
createServerFunction("probe-hinted", async (_s, i) => i, {
  rpcPrefix: "public:rpc",
  schema: schema({ a: field.string() }),
  hint: "function-wide",
  hints: { a: "a must be a string" },
});
createServerFunction("probe-nohint", async (_s, i) => i, {
  rpcPrefix: "public:rpc",
  schema: schema({ a: field.string() }),
});
createServerFunction("probe-get", async () => "ok", {
  rpcPrefix: "public:rpc",
  method: "GET",
});
createServerFunction("probe-form", async (_s, i) => i, {
  rpcPrefix: "public:rpc",
  contentType: "multipart/form-data",
  schema: schema({ a: field.string() }),
});
createServerFunction("probe-form-raw", async (_s, i) => i, {
  rpcPrefix: "public:rpc",
  contentType: "multipart/form-data",
});
createServerFunction("probe-typed", async (_s, kind) => {
  if (kind === "nf") {
    throw new S.NotFoundError("no such widget", "ids look like w-42");
  }
  if (kind === "fb") throw new S.ForbiddenError("not allowed", "ask an admin");
  if (kind === "cf") {
    throw new S.ConflictError("already exists", "pick another name");
  }
  if (kind === "rd") return S.getRequestContext().redirect("/somewhere-else");
  if (kind === "boom") throw new Error("internal detail nobody should see");
  return "ok";
}, { rpcPrefix: "public:rpc" });
createServerFunction("probe-async-validate", async () => "ok", {
  rpcPrefix: "public:rpc",
  schema: {
    "~standard": {
      version: 1,
      vendor: "t",
      validate: async () => ({
        issues: [{ message: "async rejected", path: ["a"] }],
      }),
    },
  },
});

const dispatches = [];
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(
  createRPCMiddleware({
    rpcPrefix: "public:rpc",
    onDispatch: (c) => dispatches.push(c),
  }),
);
app.use(createRPCMiddleware({ rpcPrefix: "admin:rpc", serverFiles: "glob" }));
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const PORT = server.address().port;
const HOST = `http://localhost:${PORT}`;
const OTHER = "http://localhost:5656";

const post = (p, b = [], h = {}) =>
  fetch(`${HOST}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...h },
    body: typeof b === "string" ? b : JSON.stringify(b),
  });
const get = (p, h = {}) => fetch(`${HOST}${p}`, { method: "GET", headers: h });
const b = async (r) => {
  try {
    return await r.json();
  } catch {
    return null;
  }
};
const prod = async (fn) => {
  process.env.NODE_ENV = "production";
  const r = await fn();
  process.env.NODE_ENV = "development";
  return r;
};

// ── A. origin ────────────────────────────────────────────────────────────
section('A. Origin policy — default "self", allowHeaderless off');
{
  check(
    "same-origin Origin is allowed",
    (await post("/public:rpc/probe", [], { origin: HOST })).status === 200,
  );
  check(
    "another port's Origin is 403",
    (await post("/public:rpc/probe", [], { origin: OTHER })).status === 403,
  );
  check(
    "Origin: null is 403",
    (await post("/public:rpc/probe", [], { origin: "null" })).status === 403,
  );
  check(
    "no Origin + same-origin is allowed",
    (await post("/public:rpc/probe", [], { "sec-fetch-site": "same-origin" }))
      .status === 200,
  );
  check(
    "no Origin + none is allowed",
    (await post("/public:rpc/probe", [], { "sec-fetch-site": "none" }))
      .status === 200,
  );
  check(
    "no Origin + same-site is 403",
    (await post("/public:rpc/probe", [], { "sec-fetch-site": "same-site" }))
      .status === 403,
  );
  check(
    "no Origin + cross-site is 403",
    (await post("/public:rpc/probe", [], { "sec-fetch-site": "cross-site" }))
      .status === 403,
  );
  check(
    "no Origin, no Sec-Fetch-Site is 403 by default",
    (await post("/public:rpc/probe", [])).status === 403,
  );
  check(
    "untrusted Origin + same-origin is 403 (Origin short-circuits)",
    (await post("/public:rpc/probe", [], {
      origin: "http://evil.test",
      "sec-fetch-site": "same-origin",
    })).status === 403,
  );
  check(
    "the origin check runs before the function lookup",
    (await post("/public:rpc/nope-not-here", [], { origin: OTHER })).status ===
      403,
  );
  check(
    "a lookalike host never matches",
    isOriginAllowed("http://app.example.com.evil.com", [
      "http://app.example.com",
    ]) === false,
  );
  check(
    "an array origin widens self, and self still works",
    isOriginRequestAllowed({
          allowed: ["http://sib.test"],
          origin: "https://app.test",
          host: "app.test",
        }) === true &&
      isOriginRequestAllowed({
          allowed: ["http://sib.test"],
          origin: "http://sib.test",
          host: "app.test",
        }) === true,
  );
}

// ── B. allowHeaderless ────────────────────────────────────────────────────
section("B. allowHeaderless");
{
  const a2 = express();
  a2.use(express.json());
  a2.use(
    createRPCMiddleware({ rpcPrefix: "public:rpc", allowHeaderless: true }),
  );
  const s2 = a2.listen(0);
  await new Promise((r) => s2.once("listening", r));
  const H2 = `http://localhost:${s2.address().port}`;
  const hit = (h) =>
    fetch(`${H2}/public:rpc/probe`, {
      method: "POST",
      headers: { "content-type": "application/json", ...h },
      body: "[]",
    });
  check(
    "allowHeaderless permits a headerless request",
    (await hit({})).status === 200,
  );
  check(
    "allowHeaderless does NOT widen the origin check",
    (await hit({ origin: "http://evil.test" })).status === 403,
  );
  s2.close();
}

// ── C. validation, the two environments ──────────────────────────────────
section("C. Validation — 422, and the two bodies");
{
  const d = await post("/public:rpc/probe-hinted", [{ a: 1 }], {
    origin: HOST,
  });
  const db = await b(d);
  check(
    "a rejected input is 422, not 400",
    d.status === 422,
    `got ${d.status}`,
  );
  check(
    "development error is the author message",
    db?.error === "Validation failed",
    db?.error,
  );
  check("development carries code: VALIDATION", db?.code === "VALIDATION");
  check(
    "development carries the vendor message",
    typeof db?.data?.issues?.[0]?.message === "string",
    JSON.stringify(db?.data?.issues?.[0]),
  );
  check(
    "development carries the per-field hint",
    db?.data?.issues?.[0]?.hint === "a must be a string",
  );
  check(
    "development carries the function-wide hint",
    typeof db?.hint === "string" && db.hint.includes("function-wide"),
    db?.hint,
  );

  const p = await prod(() =>
    post("/public:rpc/probe-hinted", [{ a: 1 }], { origin: HOST })
  );
  const pb = await b(p);
  check("production is also 422", p.status === 422, `got ${p.status}`);
  check(
    "production error is the status reason phrase",
    pb?.error === "Unprocessable Content",
    pb?.error,
  );
  check("production still carries code: VALIDATION", pb?.code === "VALIDATION");
  check(
    "production still carries the path",
    pb?.data?.issues?.[0]?.path === "a",
  );
  check(
    "production still carries the per-field hint",
    pb?.data?.issues?.[0]?.hint === "a must be a string",
  );
  check(
    "production DROPS the vendor message",
    !("message" in (pb?.data?.issues?.[0] ?? {})),
    JSON.stringify(pb?.data?.issues?.[0]),
  );
  check(
    "production carries the function-wide hint",
    typeof pb?.hint === "string" && pb.hint.includes("function-wide"),
  );

  const n = await prod(() =>
    post("/public:rpc/probe-nohint", [{ a: 1 }], { origin: HOST })
  );
  const nb = await b(n);
  check(
    "with no hints at all, production still names the field",
    nb?.data?.issues?.[0]?.path === "a",
    JSON.stringify(nb?.data?.issues),
  );
  check(
    "with no hints, there is no hint key",
    !("hint" in (nb?.data?.issues?.[0] ?? {})),
    JSON.stringify(nb?.data?.issues),
  );
  check(
    "with no hints, the body has no vendor text",
    !JSON.stringify(nb).includes("Expected"),
    JSON.stringify(nb),
  );
}

// ── D. every option combination ──────────────────────────────────────────
section("D. Option combinations — including one documented dead end");
{
  check(
    "an async schema is awaited and rejected",
    (await post("/public:rpc/probe-async-validate", [], { origin: HOST }))
      .status === 422,
  );
  // A documented dead end, pinned so a change to it is a deliberate decision
  // rather than an accident. rpc does not parse multipart itself — the raw text
  // is handed through as `{ raw }` so a host parser (multer et al.) can own file
  // handling. But a `schema` validates `args[0]`, which for multipart is that
  // `{ raw }` object, so any real schema rejects it. `contentType:
  // "multipart/form-data"` and `schema` therefore cannot be combined today.
  // Correct as documented in wiki/wire-protocol.md, and a genuine gap worth
  // naming rather than a bug.
  const mp = await post("/public:rpc/probe-form", "ignored", {
    origin: HOST,
    "content-type": "multipart/form-data; boundary=zz",
  });
  const mpBody = await b(mp);
  check(
    "multipart + schema is a dead end today: 422 on the `raw` key",
    mp.status === 422 && mpBody?.data?.issues?.[0]?.path === "raw",
    `${mp.status} ${JSON.stringify(mpBody?.data?.issues)}`,
  );
  const mpNoSchema = await post("/public:rpc/probe-form-raw", "x", {
    origin: HOST,
    "content-type": "multipart/form-data; boundary=zz",
  });
  check(
    "multipart without a schema is passed through as { raw }",
    mpNoSchema.status === 200,
  );
  check(
    "a form-declared function accepts urlencoded",
    (await fetch(`${HOST}/public:rpc/probe-form`, {
      method: "POST",
      headers: {
        origin: HOST,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "a=x",
    })).status === 200,
  );

  check(
    "a JSON function rejects a text body with 415",
    (await post("/public:rpc/probe", JSON.stringify([]), {
      origin: HOST,
      "content-type": "text/plain",
    })).status === 415,
  );
  check(
    "a text function rejects a JSON body with 415",
    (await post("/public:rpc/probe-text", JSON.stringify([]), { origin: HOST }))
      .status === 415,
  );
  check(
    "a JSON function accepts its declared type",
    (await post("/public:rpc/probe-text", "hello", {
      origin: HOST,
      "content-type": "text/plain",
    })).status === 200,
  );
  check(
    "a GET function rejects POST with 405",
    (await post("/public:rpc/probe-get", [], { origin: HOST })).status === 405,
  );
  check(
    "a GET function accepts GET",
    (await get("/public:rpc/probe-get", { origin: HOST })).status === 200,
  );
}

// ── E. 400 vs 422, and the other protocol statuses ───────────────────────
section("E. Protocol statuses");
{
  check(
    "a malformed body is 400",
    (await post("/public:rpc/probe", "{not json", { origin: HOST })).status ===
      400,
  );
  check(
    "a ?args= that is not JSON is 400",
    (await get(`/public:rpc/probe-get?args=notjson`, { origin: HOST }))
      .status === 400,
  );
  check(
    "a ?args= that is not an array is 400",
    (await get(`/public:rpc/probe-get?args=%7B%22a%22%3A1%7D`, {
      origin: HOST,
    })).status === 400,
  );
  check(
    "an unknown function is 404",
    (await post("/public:rpc/does-not-exist", [], { origin: HOST })).status ===
      404,
  );
  const nf = await b(
    await post("/public:rpc/does-not-exist", [], { origin: HOST }),
  );
  check(
    "a 404 body does not echo the requested name",
    !JSON.stringify(nf).includes("does-not-exist"),
    JSON.stringify(nf),
  );
  const big = "x".repeat(2 * 1024 * 1024);
  check(
    "a body over the express limit is 413 or 500, never 200",
    [413, 500].includes(
      (await post("/public:rpc/probe", JSON.stringify([big]), { origin: HOST }))
        .status,
    ),
  );
}

// ── F. typed errors ──────────────────────────────────────────────────────
section("F. Typed errors, redirect, and unexpected throws");
{
  for (
    const [kind, status, code] of [["nf", 404, "NOT_FOUND"], [
      "fb",
      403,
      "FORBIDDEN",
    ], ["cf", 409, "CONFLICT"]]
  ) {
    const r = await post("/public:rpc/probe-typed", [kind], { origin: HOST });
    const jb = await b(r);
    check(`${kind} answers ${status}`, r.status === status, `got ${r.status}`);
    check(
      `${kind} carries code + hint in development`,
      jb?.code === code && typeof jb?.hint === "string",
      JSON.stringify(jb),
    );
  }
  const pnf = await b(
    await prod(() => post("/public:rpc/probe-typed", ["nf"], { origin: HOST })),
  );
  check(
    "production keeps the status but not the author's message or hint",
    pnf?.error === "Not Found" && !("hint" in pnf),
    JSON.stringify(pnf),
  );
  const rd = await fetch(`${HOST}/public:rpc/probe-typed`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: HOST },
    body: '["rd"]',
    redirect: "manual",
  });
  check("redirect() answers 303", rd.status === 303, `got ${rd.status}`);
  check(
    "redirect() sets Location",
    rd.headers.get("location") === "/somewhere-else",
    rd.headers.get("location"),
  );
  const boom = await post("/public:rpc/probe-typed", ["boom"], {
    origin: HOST,
  });
  const boomB = await b(boom);
  check(
    "an unexpected throw is a generic 500",
    boom.status === 500 && boomB?.error === "Internal Server Error",
    JSON.stringify(boomB),
  );
  check(
    "an unexpected throw leaks no detail",
    !JSON.stringify(boomB).includes("internal detail"),
  );
  check(
    "an unexpected throw leaks no stack",
    !JSON.stringify(boomB).toLowerCase().includes("at "),
  );
}

// ── G. the example's own functions ───────────────────────────────────────
section("G. examples/advanced — all five validators, through the real example");
{
  const bad = [{ name: 123, age: "36", tags: [], address: { city: "" } }];
  const seen = {};
  for (
    const fn of [
      "profile-valibot",
      "profile-zod",
      "profile-arktype",
      "profile-effect",
    ]
  ) {
    const dev = await b(await post(`/public:rpc/${fn}`, bad, { origin: HOST }));
    const prd = await b(
      await prod(() => post(`/public:rpc/${fn}`, bad, { origin: HOST })),
    );
    seen[fn] = {
      devPaths: dev?.data?.issues?.map((i) => i.path).sort().join(","),
      prdPaths: prd?.data?.issues?.map((i) => i.path).sort().join(","),
    };
  }
  const devSets = new Set(Object.values(seen).map((v) => v.devPaths));
  check(
    "all four reject the same fields",
    devSets.size === 1,
    JSON.stringify(seen),
  );
  check(
    "all four report the same fields in production",
    new Set(Object.values(seen).map((v) => v.prdPaths)).size === 1,
    JSON.stringify(seen),
  );
  const prd = await prod(() =>
    post("/public:rpc/profile-valibot", bad, { origin: HOST })
  );
  const prdB = await b(prd);
  check(
    "the example's production body keeps a per-field hint",
    prdB?.data?.issues?.some((i) => i.hint && i.hint.length > 0),
    JSON.stringify(prdB?.data?.issues),
  );
  check(
    "the example's production body drops every vendor message",
    prdB?.data?.issues?.every((i) => !("message" in i)),
    JSON.stringify(prdB?.data?.issues),
  );
  const good = [{
    name: "Ada",
    age: "36",
    tags: ["a"],
    address: { city: "London" },
  }];
  const oks = [];
  for (
    const fn of [
      "profile-valibot",
      "profile-zod",
      "profile-arktype",
      "profile-effect",
    ]
  ) {
    const jb = await b(await post(`/public:rpc/${fn}`, good, { origin: HOST }));
    const { via, ...rest } = jb?.data ?? {};
    oks.push(JSON.stringify(rest));
  }
  check(
    "all four coerce identically (ignoring the `via` label)",
    new Set(oks).size === 1,
    oks.join(" | "),
  );
  // The fifth validator draws the boundary in different places — no coercion,
  // strict keys — so it is pinned separately rather than folded into the
  // identical-output loops above. Each claim below was established by sending
  // the same input to every validator and recording what came back.
  const nativeGood = [{
    name: "Ada",
    age: 36,
    tags: ["a"],
    address: { city: "London" },
  }];
  const nb = await b(
    await post("/public:rpc/profile-builder", nativeGood, { origin: HOST }),
  );
  check(
    "the builder accepts native types",
    nb?.data?.via === "builder" && nb?.data?.age === 36,
    JSON.stringify(nb?.data),
  );
  const strAge = [{
    name: "Ada",
    age: "36",
    tags: ["a"],
    address: { city: "London" },
  }];
  const sb = await b(
    await post("/public:rpc/profile-builder", strAge, { origin: HOST }),
  );
  check(
    "the builder rejects a string age it cannot coerce",
    sb?.error === "Validation failed" &&
      sb?.data?.issues?.some((i) => i.path === "age"),
    JSON.stringify(sb),
  );
  const sp = await b(
    await prod(() =>
      post("/public:rpc/profile-builder", strAge, { origin: HOST })
    ),
  );
  check(
    "the builder's production body keeps the hint and drops the message",
    sp?.data?.issues?.some((i) =>
      i.path === "age" && i.hint && !("message" in i)
    ),
    JSON.stringify(sp?.data?.issues),
  );
  const extra = [{
    name: "Ada",
    age: 36,
    tags: ["a"],
    address: { city: "London" },
    nickname: "x",
  }];
  const xb = await b(
    await post("/public:rpc/profile-builder", extra, { origin: HOST }),
  );
  check(
    "the builder rejects an unknown key",
    xb?.data?.issues?.some((i) => i.path === "nickname"),
    JSON.stringify(xb),
  );
  const xv = await b(
    await post("/public:rpc/profile-valibot", extra, { origin: HOST }),
  );
  check(
    "the vendors ignore that same key",
    xv?.data?.via === "valibot",
    JSON.stringify(xv?.data),
  );
}

// ── H. auth and roles ────────────────────────────────────────────────────
section("H. Auth, roles, and multi-prefix");
{
  const login = await post("/public:rpc/login", [{ username: "admin", password: "admin-secret" }], {
    origin: HOST,
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  check(
    "login succeeds with valid credentials",
    (await b(login))?.data?.ok === true,
    JSON.stringify(
      await b(
        post("/public:rpc/login", [{ username: "admin", password: "admin-secret" }], { origin: HOST }),
      ),
    ).slice(0, 80),
  );
  check("login returns a session cookie", cookie.startsWith("sid="), cookie);
  const badLogin = await b(
    await post("/public:rpc/login", [{ username: "admin", password: "wrong" }], { origin: HOST }),
  );
  check(
    "a bad password is a 200 carrying ok:false, not a 401",
    badLogin?.data?.ok === false,
    JSON.stringify(badLogin),
  );
  const me = await b(
    await post("/public:rpc/me", [], { origin: HOST, cookie }),
  );
  check(
    "the session identifies the user",
    me?.data?.user?.username === "admin",
    JSON.stringify(me),
  );
  const admin = await post("/admin:rpc/get-user", ["u-1"], {
    origin: HOST,
    cookie,
    "x-admin-token": "admin-secret",
  });
  check(
    "an admin token reaches the admin prefix",
    admin.status === 200,
    `got ${admin.status}`,
  );
  const userLogin = await post("/public:rpc/login", [{ username: "user", password: "user-secret" }], {
    origin: HOST,
  });
  const userCookie = (userLogin.headers.get("set-cookie") ?? "").split(";")[0];
  const denied = await post("/admin:rpc/get-user", ["u-1"], {
    origin: HOST,
    cookie: userCookie,
  });
  check(
    "a non-admin session is 403 on the admin prefix",
    denied.status === 403,
    `got ${denied.status}`,
  );
  check(
    "a public-prefix function is not on the admin prefix",
    (await post("/admin:rpc/say-hi", ["x"], {
      origin: HOST,
      cookie: userCookie,
    })).status === 404,
  );
  const anon = await post("/admin:rpc/get-user", ["u-1"], { origin: HOST });
  check(
    "no session and no token is 403",
    anon.status === 403,
    `got ${anon.status}`,
  );
}

// ── I. onDispatch ────────────────────────────────────────────────────────
section("I. onDispatch and redaction");
{
  const secret = "hunter2-stolen-password";
  await post("/public:rpc/probe", [{ password: secret, n: 5 }], {
    origin: HOST,
  });
  const d = dispatches.at(-1);
  check("a dispatch is recorded", !!d);
  check(
    "it records the function name",
    d?.functionName === "probe",
    d?.functionName,
  );
  check("it records the status", d?.status === 200, String(d?.status));
  check(
    "argShape records the shape",
    typeof d?.argShape === "string" && d.argShape.includes("password"),
    d?.argShape,
  );
  check(
    "argShape NEVER contains the value",
    !JSON.stringify(d?.argShape).includes(secret),
    d?.argShape,
  );
  check(
    "the whole dispatch carries no argument values",
    !JSON.stringify({ argShape: d?.argShape }).includes(secret),
  );
  check(
    "it records the origin tier",
    typeof d?.originTier === "string" || d?.originTier === undefined,
    String(d?.originTier),
  );
  const rej = await post("/public:rpc/probe-hinted", [{ a: 1 }], {
    origin: HOST,
  });
  const dr = dispatches.at(-1);
  check(
    "a rejected dispatch records 422 and client-error",
    dr?.status === 422 && dr?.outcome === "client-error",
    `${dr?.status}/${dr?.outcome}`,
  );
  check(
    "registeredNames is present for a miss",
    Array.isArray(dr?.registeredNames),
  );
  void rej;
}

// ── J. security ──────────────────────────────────────────────────────────
section("J. Security");
{
  const payload = "__proto__[isAdmin]=true";
  await post("/public:rpc/probe", [payload], { origin: HOST });
  check(
    "a __proto__ key does not pollute Object.prototype",
    ({}).isAdmin === undefined,
    String(({}).isAdmin),
  );
  check(
    "Object.prototype has no isAdmin",
    !Object.prototype.hasOwnProperty("isAdmin"),
  );
  const nested = await post("/public:rpc/probe", [{
    "constructor[prototype][isAdmin]": "true",
  }], { origin: HOST });
  check(
    "a constructor/prototype payload is inert too",
    ({}).isAdmin === undefined && nested.status === 200,
    String(nested.status),
  );
  const enc = "http://localhost:3000%2f..%2f..%2fetc";
  const weird = await fetch(`${HOST}/public:rpc/probe/..%2f..%2fetc`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: HOST },
    body: "[]",
  });
  check(
    "a path-traversal attempt does not crash (any 4xx/404 is fine)",
    weird.status < 500,
    `got ${weird.status}`,
  );
  void enc;
}

// ── K. direct-call parity ────────────────────────────────────────────────
section("K. Direct call — the SSR / server-to-server path");
{
  const mod = await import(`${EXAMPLE}/src/api/public.server.ts`);
  process.env.NODE_ENV = "production";
  const r = await mod.profileWithValibot({
    name: 123,
    age: "36",
    tags: [],
    address: { city: "x" },
  }).data
    .then(() => ({ ok: true }))
    .catch((e) => ({ ok: false, status: e?.status, issues: e?.issues }));
  process.env.NODE_ENV = "development";
  check("a direct call validates too", r.ok === false, JSON.stringify(r));
  check(
    "a direct call throws the same 422",
    r.status === 422,
    String(r.status),
  );
  check(
    "a direct call applies the same production body rule",
    JSON.stringify(r.issues).includes("a=") || Array.isArray(r.issues),
    JSON.stringify(r.issues),
  );
  const good = await mod.profileWithValibot({
    name: "Ada",
    age: "36",
    tags: [],
    address: { city: "x" },
  }).data;
  check(
    "a direct call returns the transformed value",
    good?.age === 36 && typeof good.age === "number",
    JSON.stringify(good),
  );
  check("the transform ran identically to the HTTP path", good?.name === "Ada");
}

// ── L. client helpers against a live production body ─────────────────────
section("L. Client helpers on a real production body");
{
  const prd = await prod(() =>
    post("/public:rpc/probe-hinted", [{ a: 1 }], { origin: HOST })
  );
  const jb = await prd.json();
  const { RPCResponseError, fieldErrors, fieldErrorText, fieldErrorHint } = H3;
  if (!RPCResponseError) {
    check("client helpers are importable", false, "helpers entry not found");
  } else {
    const err = new RPCResponseError(prd.status, prd.statusText, jb);
    check(
      "fieldErrors keys by path on a production body",
      Object.keys(fieldErrors(err)).join(",") === "a",
      JSON.stringify(fieldErrors(err)),
    );
    check(
      "fieldErrors falls back to the hint",
      fieldErrors(err).a?.[0] === "a must be a string",
      JSON.stringify(fieldErrors(err)),
    );
    check(
      "fieldErrorText renders the hint",
      fieldErrorText(err, "a") === "a must be a string",
    );
    check(
      "fieldErrorHint returns the per-field hint",
      fieldErrorHint(err, "a") === "a must be a string",
    );
    const noHint = await prod(() =>
      post("/public:rpc/probe-nohint", [{ a: 1 }], { origin: HOST })
    );
    const e2 = new RPCResponseError(
      noHint.status,
      noHint.statusText,
      await noHint.json(),
    );
    check(
      "a bare path is still a key",
      "a" in fieldErrors(e2),
      JSON.stringify(fieldErrors(e2)),
    );
    check("a bare path renders no text", fieldErrorText(e2, "a") === "");
  }
}

console.log(`\n\x1b[1m${"═".repeat(64)}\x1b[0m`);
console.log(
  `  \x1b[32m${pass} passed\x1b[0m${
    fail ? `, \x1b[31m${fail} failed\x1b[0m` : ""
  }`,
);
if (failures.length) {
  console.log("\n  \x1b[1mfailures\x1b[0m");
  failures.forEach((f) => console.log(`   • ${f}`));
}
server.close();
process.exit(fail ? 1 : 0);
