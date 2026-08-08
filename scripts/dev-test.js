/**
 * Integration test runner for all @thednp/rpc example apps.
 *
 * Iterates through each example (spa, express, fastify, hono, koa, ssr),
 * starts its dev server, verifies the RPC `add` endpoint returns `{ data: 5 }`,
 * and reports pass/fail results in a table.
 *
 * Usage:
 *   node scripts/dev-test.js              # test all examples
 *   node scripts/dev-test.js --filter=koa # test only matching examples
 *   node scripts/dev-test.js --mode=preview # test built preview servers
 *
 * Flow:
 *   1. rootSetup() — install deps & build dist/ if missing
 *   2. Switch each example's @thednp/rpc dep to `link:../..` (saving the
 *      original published version), reinstall
 *   3. Kill any process on ROOT_PORT (5173)
 *   4. For each example:
 *      a. Kill ROOT_PORT again
 *      b. Spawn `pnpm dev` as detached child
 *      c. Wait for port to respond (up to 20s)
 *      d. Warm up Vite's lazy compilation (WARMUP_DELAY ms)
 *      e. POST to /{prefix}/add with {a:2, b:3}
 *      f. Kill process tree and record result
 *   5. In a finally block, restore the original published version and reinstall
 *   6. Print results table; exit 1 if any test failed
 *
 * Environment:
 *   Requires pnpm, fuser, and a running Linux environment.
 *   Port 5173 must be free before starting.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const cwd = process.cwd();
const ROOT_PORT = 5173;
const RPC_MAX_TIMEOUT = 10000; // 20000
const RPC_TIMEOUT = 2000;
const RPC_KILL_TIMEOUT = 1000; // 5000
const WARMUP_DELAY = 500;

const RPC_DEP_NAME = "@thednp/rpc";
const RPC_LINK = "link:../..";

// Default @thednp/rpc version, read from the root package.json at runtime
// so restoreDeps() always falls back to the latest published version.
const RPC_VERSION = `^${JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf-8")).version}`;

const PREFIX_MAP = {
  express: "__A_server",
  fastify: "_server",
  hono: "_server",
  koa: "__A_server",
  "react-query": "__A_server",
  "solid-query": "__A_server",
  spa: "_server",
  ssr: "_server",
};

const results = [];

async function readExamplePkg(example) {
  const file = path.join(cwd, "examples", example, "package.json");
  return {
    file,
    pkg: JSON.parse(await fs.readFile(file, "utf-8")),
  };
}

async function writeExamplePkg(file, pkg) {
  await fs.writeFile(file, JSON.stringify(pkg, null, 2) + "\n");
}

/**
 * Switches every example's @thednp/rpc dependency to `link:../..` so tests
 * exercise the local source instead of the published npm version.
 * Returns the saved original dependency values for restoreDeps().
 */
async function switchExamplesToLink(examples) {
  const saved = [];
  for (const example of examples) {
    const { file, pkg } = await readExamplePkg(example);
    const original = pkg.dependencies?.[RPC_DEP_NAME] ?? null;
    saved.push({ example, file, original });
    if (original !== null) {
      pkg.dependencies[RPC_DEP_NAME] = RPC_LINK;
      await writeExamplePkg(file, pkg);
      console.log(
        `[${example}] Switched ${RPC_DEP_NAME} ${original} -> ${RPC_LINK}`,
      );
    }
  }
  return saved;
}

/**
 * Restores each example's @thednp/rpc dependency to its saved original value.
 */
async function restoreDeps(saved) {
  for (const { example, file, original } of saved) {
    const { pkg } = await readExamplePkg(example);
    if (original === null) {
      // Default to the latest version from the root package.json
      pkg.dependencies[RPC_DEP_NAME] = RPC_VERSION;
    } else {
      pkg.dependencies[RPC_DEP_NAME] = original;
    }
    await writeExamplePkg(file, pkg);
    console.log(`[${example}] Restored ${RPC_DEP_NAME} to ${pkg.dependencies[RPC_DEP_NAME]}`);
  }
}

async function run(cmd, args, options = {}, timeoutMs = 120_000) {
  const { cwd: cwdPath, env: envVars, ...rest } = options;
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: cwdPath,
      stdio: "pipe",
      env: { ...process.env, ...envVars },
      ...rest,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(
        new Error(
          `Command timed out after ${timeoutMs}ms: ${cmd} ${args.join(" ")}`,
        ),
      );
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else {
        reject(
          new Error(
            `Command failed with code ${code}: ${cmd} ${args.join(" ")}\n${stderr}`,
          ),
        );
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function killPort(port) {
  try {
    await run("fuser", ["-k", `${port}/tcp`], {}, RPC_KILL_TIMEOUT);
  } catch {
    // nothing listening or fuser not available — continue
  }

  try {
    await run("pkill", ["-f", "node server"], {}, RPC_KILL_TIMEOUT);
  } catch {
    // no node processes
  }
  try {
    await run("pkill", ["-f", "vite"], {}, RPC_KILL_TIMEOUT);
  } catch {
    // no vite processes
  }
}

async function waitForPort(port, timeoutMs = RPC_MAX_TIMEOUT) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}`);
      if (
        res.ok ||
        res.status === 301 ||
        res.status === 302 ||
        res.status === 404
      ) {
        return true;
      }
    } catch {
      // port not ready
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Port ${port} did not respond within ${timeoutMs}ms`);
}

async function verifyRPC(prefix) {
  const endpoint = `http://localhost:${ROOT_PORT}/${prefix}/add-numbers`;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    RPC_TIMEOUT,
  );

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(['{"a":2,"b":3}']),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const raw = await res.text();
    const parsed = JSON.parse(raw);
    if (parsed.error) {
      throw new Error(`RPC error: ${parsed.error}`);
    }
    if (parsed.data !== 5) {
      throw new Error(`Unexpected result: ${JSON.stringify(parsed)}`);
    }
    return true;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("RPC verification timed out");
    }
    throw err;
  }
}

async function verifyGET(prefix) {
  const endpoint =
    `http://localhost:${ROOT_PORT}/${prefix}/get-server-time` +
    `?args=${encodeURIComponent(JSON.stringify(["en-US"]))}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RPC_TIMEOUT);

  try {
    const res = await fetch(endpoint, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const parsed = await res.json();
    if (parsed.error) {
      throw new Error(`RPC error: ${parsed.error}`);
    }
    if (parsed.data?.locale !== "en-US" || !parsed.data?.time) {
      throw new Error(`Unexpected result: ${JSON.stringify(parsed)}`);
    }
    return true;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("GET verification timed out");
    }
    throw err;
  }
}

async function verifyHTML(name) {
  const endpoint = `http://localhost:${ROOT_PORT}/`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RPC_TIMEOUT);
  try {
    const res = await fetch(endpoint, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) {
      throw new Error(`HTML page returned HTTP ${res.status}`);
    }
    const text = await res.text();
    if (text.length === 0) {
      throw new Error("HTML response body is empty");
    }
    if (name !== "spa") {
      if (text.includes("<!--app-html-->")) {
        throw new Error(
          "SSR placeholder was not replaced in HTML response",
        );
      }
      if (
        !text.includes("Hello World") &&
        !text.includes("Hello Jane") &&
        !text.includes('id="addForm"')
      ) {
        throw new Error(
          "HTML body missing expected SSR content",
        );
      }
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      throw new Error(`Unexpected content-type: ${contentType}`);
    }
    return true;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("HTML verification timed out");
    }
    throw err;
  }
}

async function rootSetup() {
  const distDir = path.join(cwd, "dist");

  console.log("[setup] Installing root dependencies...");
  await run("pnpm", ["install", "--no-frozen-lockfile"], {
    cwd,
    env: { ...process.env, CI: "true" },
  }, 180_000);

  const distExists = await fs
    .stat(distDir)
    .then(() => true)
    .catch(() => false);

  if (!distExists) {
    console.log("[setup] dist/ not found — building @thednp/rpc package...");
    await run("pnpm", ["build"], {
      cwd,
      env: { ...process.env, CI: "true" },
    }, 120_000);
  }
}

function killProcessTree(proc) {
  if (proc.pid) {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      // already dead
    }
  }
}

// process args
const args = process.argv.slice(2);
const filterArg = args.find((a) => a.startsWith("--filter="));
const filterRe = filterArg ? new RegExp(filterArg.split("=")[1]) : null;

const modeArg = args.find((a) => a.startsWith("--mode="));
const mode = modeArg ? modeArg.split("=")[1] : "dev";
if (mode !== "dev" && mode !== "preview") {
  console.error("Invalid mode. Use --mode=dev or --mode=preview");
  process.exit(1);
}

// kill any running dev/preview instance
await killPort(ROOT_PORT);

(async () => {
  await rootSetup();

  const entries = await fs.readdir(path.resolve(cwd, "examples"));
  let examples = entries.filter((d) => {
    return PREFIX_MAP[d] !== undefined;
  });
  if (filterRe) examples = examples.filter((d) => filterRe.test(d));

  if (examples.length === 0) {
    console.log("No matching examples found.");
    process.exit(0);
  }

  let savedDeps = [];
  let switched = false;
  try {
    // Point examples at the local source so tests exercise this checkout
    savedDeps = await switchExamplesToLink(examples);
    if (savedDeps.length > 0) {
      await run("pnpm", ["install", "--no-frozen-lockfile"], {
        cwd,
        env: { ...process.env, CI: "true" },
      }, 180_000);
      switched = true;
    }

    for (const example of examples) {
      const exampleDir = path.join(cwd, "examples", example);
      const prefix = PREFIX_MAP[example];
      const start = Date.now();

      try {
        await killPort(ROOT_PORT);

        console.log(`[${example}] Starting ${mode} server...`);
        const testProc = spawn("pnpm", ["run", mode], {
          cwd: exampleDir,
          stdio: "pipe",
          detached: true,
        });

        let stderr = "";
        testProc.stderr?.on("data", (d) => (stderr += d.toString()));

        await waitForPort(ROOT_PORT, RPC_MAX_TIMEOUT);

        const exited = new Promise((resolve) => {
          testProc.on("close", resolve);
        });

        console.log(`[${example}] Port ready — warming up (${WARMUP_DELAY}ms)...`);
        await new Promise((r) => setTimeout(r, WARMUP_DELAY));

        if (testProc.exitCode !== null) {
          throw new Error(
            `Dev server exited early with code ${testProc.exitCode}\n${stderr}`,
          );
        }

        console.log(`[${example}] Verifying RPC endpoint /${prefix}/add ...`);
        await verifyRPC(prefix);
        console.log(`[${example}] Verifying GET endpoint /${prefix}/get-server-time ...`);
        await verifyGET(prefix);
        console.log(`[${example}] Verifying HTML output ...`);
        await verifyHTML(example);

        killProcessTree(testProc);
        await exited.catch(() => { });

        const duration = `${Date.now() - start}ms`;
        console.log(`[${example}] Passed (${duration})`);
        results.push({ example, status: "pass", duration, error: "" });
      } catch (err) {
        const duration = `${Date.now() - start}ms`;
        console.error(`[${example}] Failed (${duration}): ${err.message}`);
        results.push({
          example,
          status: "fail",
          duration,
          error: err.message.split("\n")[0],
        });
      }
    }
  } finally {
    // Always restore the published version, even when tests fail
    if (switched) {
      await restoreDeps(savedDeps);
      await run("pnpm", ["install", "--no-frozen-lockfile"], {
        cwd,
        env: { ...process.env, CI: "true" },
      }, 180_000);
    }
    await killPort(ROOT_PORT);
  }

  console.log("\n");
  console.table(results);

  const failed = results.filter((r) => r.status === "fail");
  process.exit(failed.length > 0 ? 1 : 0);
})();
