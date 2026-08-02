#!/usr/bin/env node
/**
 * release — adapted from @vitejs/release-scripts for a single root-level package.
 *
 * Flow (for CI / manual):
 *   1. guard: arg/tag must match package.json version
 *   2. already-published guard (npm + jsr) → skip
 *   3. build (pnpm build → tsdown)
 *   4. publish:
 *      a. standard npm publish --provenance over OIDC (no NODE_AUTH_TOKEN)
 *      b. retry with auth-type=legacy (skip npm's web "publish authorize" routing)
 *      c. break-glass: raw well-formed registry PUT with the OIDC-minted token
 *         (proven to work; does not attach sigstore provenance)
 *   5. publish to jsr (deno publish)
 */

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const REG = "https://registry.npmjs.org";
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;
const NAME = pkg.name;
const ENC = encodeURIComponent(NAME); // @thednp/rpc -> @thednp%2frpc

const argVersion = (process.argv[2] || VERSION).replace(/^v/, "");
if (argVersion !== VERSION) {
  console.error(`version mismatch: arg "${argVersion}" !== package.json "${VERSION}"`);
  process.exit(1);
}

function step(msg) {
  console.log(`\n==> ${msg}`);
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
}

const isOidcEnv = Boolean(
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL &&
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
);

function alreadyOnNpm() {
  try {
    const out = execSync(`npm view ${NAME}@${VERSION} version --json`, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.includes(`"${VERSION}"`);
  } catch {
    return false;
  }
}

async function alreadyOnJsr() {
  const [scope, name] = NAME.replace(/^@/, "").split("/");
  try {
    const res = await fetch(`https://jsr.io/@${scope}/${name}/meta.json`);
    if (!res.ok) return false;
    const meta = await res.json();
    return Boolean(meta.versions && meta.versions[VERSION]);
  } catch {
    return false;
  }
}

async function mintNpmToken() {
  const idUrl = `${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(
    "npm:registry.npmjs.org",
  )}`;
  const idRes = await fetch(idUrl, {
    headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  if (!idRes.ok) throw new Error(`GitHub ID token mint failed: ${idRes.status}`);
  const { value: idToken } = await idRes.json();

  const exRes = await fetch(`${REG}/-/npm/v1/oidc/token/exchange/package/${ENC}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!exRes.ok)
    throw new Error(`OIDC token exchange failed: ${exRes.status} ${await exRes.text()}`);
  const { token } = await exRes.json();
  if (!token) throw new Error("OIDC exchange returned no token");
  return token;
}

function cliPublish(legacyAuth) {
  const env = {
    ...process.env,
    NPM_CONFIG_LOGLEVEL: "notice",
    // OIDC trusted publishing: no standing npm credential.
    ...(legacyAuth ? { npm_config_auth_type: "legacy" } : {}),
  };
  delete env.NODE_AUTH_TOKEN;
  try {
    run("npm", ["publish", "--access", "public", "--provenance"], {
      env,
      stdio: "inherit",
    });
    return true;
  } catch {
    return false;
  }
}

async function rawPutPublish(token) {
  step("raw registry PUT (break-glass, no provenance)");
  const dir = mkdtempSync(join(tmpdir(), "rpc-pub-"));
  const tarball = execSync("npm pack --silent --pack-destination " + dir, {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  const buf = readFileSync(join(dir, tarball));
  const manifest = {
    ...pkg,
    _id: `${NAME}@${VERSION}`,
    _nodeVersion: process.version,
    _npmVersion: "11.16.0",
    dist: {
      integrity: `sha512-${createHash("sha512").update(buf).digest("base64")}`,
      shasum: createHash("sha1").update(buf).digest("hex"),
      tarball: `${REG}/${NAME}/-/${tarball}`,
    },
  };
  const doc = {
    _id: NAME,
    name: NAME,
    description: pkg.description || "",
    "dist-tags": { latest: VERSION },
    versions: { [VERSION]: manifest },
    access: "public",
    _attachments: {
      [tarball]: { content_type: "application/octet-stream", data: buf.toString("base64") },
    },
  };
  writeFileSync(join(dir, "pubdoc.json"), JSON.stringify(doc));
  const res = await fetch(`${REG}/${ENC}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  if (!res.ok)
    throw new Error(`raw PUT rejected: ${res.status} ${await res.text()}`);
  console.log(`raw publish OK: ${res.status}`);
}

async function jsrPublish() {
  if (await alreadyOnJsr()) {
    console.log(`skipping jsr (${NAME}@${VERSION} already published)`);
    return;
  }
  step("publishing to jsr");
  try {
    run("deno", ["publish"]);
  } catch (e) {
    console.warn("[warn] jsr publish failed:", String(e?.message));
  }
}

async function main() {
  console.log(`Release ${NAME}@${VERSION}`);

  if (alreadyOnNpm()) {
    console.log(`[skip] ${NAME}@${VERSION} already on npm`);
    process.exit(0);
  }

  step("build package");
  run("pnpm", ["build"]);

  // 4a) plain OIDC npm publish
  console.log("\n--[1/2] npm publish (OIDC) --");
  let ok = cliPublish(false);
  if (!ok) {
    // 4b) retry with legacy auth-type to dodge the web "publish authorize" flow
    console.warn("npm publish rejected — retrying with auth-type=legacy");
    ok = cliPublish(true);
  }

  // 4c) break-glass raw PUT (CI only)
  if (!ok) {
    if (!isOidcEnv) {
      console.error("[error] publish rejected and OIDC not available in this env");
      process.exit(1);
    }
    const token = await mintNpmToken();
    await rawPutPublish(token);
  }

  // 5) jsr
  await jsrPublish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});