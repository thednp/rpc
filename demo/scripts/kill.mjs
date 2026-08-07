#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const patterns = ["[v]ite.js preview", "node server", "node --experimental-strip-types ./server\\.ts$"];

try {
  console.log("Killing vite/[node server] processes..");

  for (const pattern of patterns) {
    const { status, error } = spawnSync("pkill", ["-f", pattern], { stdio: "inherit" });
    if (error) { console.error("pkill failed:", error); continue; }
    console.log(status === 0 ? `Killed: ${pattern}` : `Nothing matched: ${pattern}`);
  }
  console.log("Done");
} catch (e) {
  console.error("An error occured", e);
}
