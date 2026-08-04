import { defineConfig, type UserConfig } from "tsdown";
import strip from "vite-plugin-strip-comments";

const sharedCfg: UserConfig = {
  target: "esnext",
  format: ["esm"],
  deps: {
    neverBundle: [
      "node",
      "vite",
      "hono",
      "@hono/node-server",
      "koa",
      "fastify",
      "fastify-plugin",
      "express",
      "picocolors",
      "@thednp/rpc",
      "@thednp/rpc/server",
    ],
    onlyBundle: false
  },
  // treeshake: true,
  plugins: [strip({ type: "keep-jsdoc" })],
  exports: {
    inlinedDependencies: false,
    packageJson: true,
  },
  // dts: true,
  dts: {
    sourcemap: true,
    sideEffects: false,
  },
  // skipNodeModulesBundle: true,
  // clean: true,
};

export default defineConfig([
  {
    ...sharedCfg,
    clean: true,
    entry: {
      server: "src/server.ts",
    },
    outDir: "dist/server",
  },

  {
    ...sharedCfg,
    entry: {
      express: "src/express/index.ts",
    },
    outDir: "dist/express",
  },
  {
    ...sharedCfg,
    entry: {
      fastify: "src/fastify/index.ts",
    },
    outDir: "dist/fastify",
  },
  {
    ...sharedCfg,
    entry: {
      "fastify/plugin": "src/fastify/plugin.ts",
    },
    outDir: "dist/fastify/plugin",
  },
  {
    ...sharedCfg,
    entry: {
      hono: "src/hono/index.ts",
    },
    outDir: "dist/hono",
  },
  {
    ...sharedCfg,
    entry: {
      koa: "src/koa/index.ts",
    },
    outDir: "dist/koa",
  },
  // helpers
  {
    ...sharedCfg,
    entry: {
      helpers: "src/helpers.ts",
    },
    outDir: "dist/helpers",
  },
  // vite plugin last
  {
    ...sharedCfg,
    entry: {
      index: "src/index.ts",
    },
    outDir: "dist",
  },
]);
