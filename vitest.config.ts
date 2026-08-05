import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // applied in tests
      "@thednp/rpc/express": new URL("src/express/index.ts", import.meta.url).pathname,
      "@thednp/rpc/server": new URL("src/server.ts", import.meta.url).pathname,
      "@thednp/rpc": new URL("src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    globals: true,
    include: [
      "tests/**.test.ts"
    ],
    coverage: {
      provider: "istanbul",
      reporter: ["html", "text", "lcov"],
      enabled: true,
      include: ["src"],
      // exclude: ["src/index copy.ts"],
    },
  },
});
