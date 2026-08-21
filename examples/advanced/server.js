import fs from "node:fs/promises";
import express from "express";

// Constants
const isProduction = process.env.NODE_ENV === "production";
const MODE = process.env.NODE_ENV || "development";
const port = process.env.PORT || 5173;
const base = process.env.BASE || "/";
const root = process.env.ROOT || process.cwd();

// Cached production assets
const templateHtml = isProduction
  ? await fs.readFile("./dist/client/index.html", "utf-8")
  : "";

// Create http server
const app = express();
app.use(express.json({ limit: 1024 * 1024 }));

// RPC middleware for the admin prefix — registered explicitly (the Vite
// plugin only auto-mounts the configured prefix in dev). `serverFiles: "glob"`
// is required so the lazy production scan finds `*.server.ts` files (the
// default is `"exact"` which only matches `server.ts`).
const { createRPCMiddleware } = await import("@thednp/rpc/express");
const adminMiddleware = createRPCMiddleware({
  rpcPrefix: "admin:rpc",
  serverFiles: "glob",
});

// Add Vite or respective production middlewares
/** @type {import('vite').ViteDevServer | undefined} */
let vite;
if (!isProduction) {
  const { createServer } = await import("vite");
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    base,
    root,
  });

  // Multi-prefix: the plugin mounts `public:rpc` middleware on Vite's
  // connect server; the admin prefix is handled by the explicit middleware.
  app.use(adminMiddleware);
  app.use(vite.middlewares);
} else {
  const compression = (await import("compression")).default;
  const sirv = (await import("sirv")).default;
  // load RPC configuration
  const { loadRPCConfig } = await import("@thednp/rpc");
  const { adapter, ...options } = await loadRPCConfig();
  app.use(createRPCMiddleware(options));
  app.use(adminMiddleware);

  // other middleware
  app.use(compression());
  app.use(base, sirv("./dist/client", { extensions: [] }));
}

// SSR guard for privileged pages — mirrors the RPC auth boundary.
// Public bundle never contains admin stubs, but HTML for /admin must also be gated.
const getSessionFromReq = (req) => {
  const raw = req.headers.cookie || "";
  const m = raw.match(/(?:^|;\s*)sid=([^;]+)/);
  const sid = m ? decodeURIComponent(m[1]) : null;
  if (!sid) return null;
  const store = globalThis[Symbol.for("thednp.rpc.advanced.session")];
  if (!store) return null;
  return store.get(sid) ?? null;
};

// Serve HTML
app.use("*all", async (req, res) => {
  try {
    const url = req.originalUrl.replace(base, "");
    const pathname = new URL(req.originalUrl, "http://localhost").pathname.replace(base, "");
    // Multi-page guard: /admin and /admin/* require admin session
    if (pathname === "admin" || pathname.startsWith("admin/")) {
      const sess = getSessionFromReq(req);
      if (sess?.role !== "admin") {
        res.status(403).set({ "Content-Type": "text/html" }).send(`
          <h1>403 — Admin only</h1>
          <p>This page requires an admin session. <a href="/">Go to login</a></p>
        `.trim());
        return;
      }
    }

    /** @type {string} */
    let template;
    /** @type {import('./src/entry-server.ts').render} */
    let render;
    if (!isProduction) {
      // Always read fresh template in development
      template = await fs.readFile("./index.html", "utf-8");
      template = await vite.transformIndexHtml(url, template);
      render = (await vite.ssrLoadModule("/src/entry-server.ts")).render;
    } else {
      template = templateHtml;
      render = (await import("./dist/server/entry-server.js")).render;
    }

    const rendered = await render(url);
    const html = template
      .replace(`<!--app-html-->`, rendered.html ?? "");

    res.status(200).set({ "Content-Type": "text/html" }).send(html.trim());
  } catch (e) {
    vite?.ssrFixStacktrace(e);
    console.error(e.stack);
    res.status(500).end("Internal Server Error");
  }
});

// Start http server
app.listen(port, () => {
  console.log(
    `  ➜  Server started in "${MODE}" mode at http://localhost:${port}`,
  );
});