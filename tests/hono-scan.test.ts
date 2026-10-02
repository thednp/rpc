import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { createMiddleware } from "../src/hono/createMiddleware.ts";
import {
  getFunctionsForPrefix,
  serverFunctionsByPrefix,
} from "../src/functionsMap.ts";
import { scanForServerFiles } from "../src/scanForServerFiles.ts";
import { setGlobalPrefix } from "../src/server.ts";

vi.mock("../src/scanForServerFiles.ts", () => ({
  scanForServerFiles: vi.fn(),
}));

const scanned = vi.mocked(scanForServerFiles);

describe("hono bare middleware production scan", () => {
  beforeEach(() => {
    for (const map of serverFunctionsByPrefix.values()) {
      map.clear();
    }
    setGlobalPrefix(undefined);
    scanned.mockClear();
  });

  afterEach(() => {
    for (const map of serverFunctionsByPrefix.values()) {
      map.clear();
    }
    setGlobalPrefix(undefined);
  });

  it("scans with the resolved global prefix rather than an absent explicit prefix", async () => {
    setGlobalPrefix("@demo");
    expect(getFunctionsForPrefix("@demo").size).toBe(0);

    const handler = async () => new Response("ok");
    const app = new Hono();
    app.use(createMiddleware({ handler, name: "global-prefix-scan" }));

    const response = await app.fetch(new Request("http://localhost/ping"));
    expect(await response.text()).toBe("ok");
    expect(scanned).toHaveBeenCalledWith(
      expect.objectContaining({ rpcPrefix: "@demo" }),
    );
  });
});
