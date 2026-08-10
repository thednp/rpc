/**
 * Audits only the root package's dependencies, excluding the examples' deps
 * (examples reference the last published @thednp/rpc version, which should not
 * gate a release of the source package).
 *
 * Creates a temp project with the root package.json dependencies, mirrors the
 * workspace overrides, generates a lockfile, and runs `pnpm audit` there.
 *
 * Usage:
 *   node scripts/audit-src.js
 *   pnpm audit:src
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const PKG_FIELDS = ["dependencies", "devDependencies", "packageManager"];
const WORKSPACE = `packages:
  - "."
overrides:
  '@hono/node-server': '^2.1.0'
`;

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-audit-"));

try {
  const scoped = {
    name: "rpc-audit",
    version: "0.0.0",
    private: true,
    ...Object.fromEntries(
      PKG_FIELDS.map((f) => [f, pkg[f]]).filter(([, v]) => v !== undefined),
    ),
  };
  fs.writeFileSync(
    path.join(tempDir, "package.json"),
    JSON.stringify(scoped, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(tempDir, "pnpm-workspace.yaml"), WORKSPACE);

  const run = (cmd, args) => {
    const res = spawnSync(cmd, args, {
      cwd: tempDir,
      stdio: "pipe",
      env: { ...process.env, CI: "true" },
      encoding: "utf-8",
    });
    if (res.status !== 0) {
      console.error(res.stderr || res.stdout);
      process.exit(res.status ?? 1);
    }
    return res.stdout;
  };

  console.log("[audit:src] Resolving root dependencies...");
  run("pnpm", ["install", "--lockfile-only", "--no-frozen-lockfile"]);

  console.log("[audit:src] Auditing root dependencies...");
  const out = run("pnpm", ["audit", "--json"]);
  const report = JSON.parse(out);
  const { vulnerabilities, totalDependencies } = report.metadata;
  const hasVulns = Object.values(vulnerabilities).some((n) => n > 0);

  if (hasVulns) {
    const found = Object.entries(report.vulnerabilities ?? {})
      .map(([name, v]) => `${name} (${v.severity})`)
      .join(", ");
    console.error(
      `[audit:src] Found vulnerabilities in ${totalDependencies} audited deps: ${found}`,
    );
    process.exit(1);
  }
  console.log(
    `[audit:src] Clean — no vulnerabilities in ${totalDependencies} audited deps`,
  );
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
