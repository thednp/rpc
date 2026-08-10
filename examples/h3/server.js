// server.js
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { H3 } from "h3";
import { toNodeListener } from "h3/node";
import { loadRPCConfig } from "@thednp/rpc";

// Constants
const isProduction = process.env.NODE_ENV === "production";
const MODE = process.env.NODE_ENV || "development";
const port = Number(process.env.PORT) || 5173;
const base = process.env.BASE || "/";
const root = process.env.ROOT || process.cwd();
const rpcConfig = await loadRPCConfig();

// Cached production assets
const templateHtml = isProduction
  ? await fs.readFile("./dist/client/index.html", "utf-8")
  : "";

// Create h3 app
const app = new H3();

/** @type {import('vite').ViteDevServer | undefined} */
let vite;
if (!isProduction) {
  const { createServer: createViteServer } = await import("vite");
  const { viteMiddleware } = await import("@thednp/rpc/h3");

  vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "custom",
    base,
    root,
  });

  // All requests go through the Vite connect stack (dev assets, HMR, and the
  // RPC middleware the plugin registers via configureServer).
  app.use(viteMiddleware(vite));
} else {
  const { bodyLimit } = await import("./middleware/bodyLimit.js");
  const { serveStatic } = await import("./middleware/serveStatic.js");
  const { createRPCMiddleware } = await import("@thednp/rpc/h3");
  const { adapter: _adapter, ...options } = rpcConfig;

  // Body size limit — enforced before RPC middleware (defense-in-depth)
  app.use(bodyLimit);

  // RPC Middleware
  app.use(createRPCMiddleware(options));

  // Serve static files
  app.use(serveStatic);
}

// SSR fallback — must come AFTER static files so assets are served first
app.use(async (event) => {
  const url = event.url.pathname.replace(base, "");

  try {
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

    return new Response(html.trim(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch (e) {
    vite?.ssrFixStacktrace(e);
    console.error(e.stack);
    return new Response("Internal Server Error", { status: 500 });
  }
});

// Start http server
createServer(toNodeListener(app)).listen(port, () => {
  console.log(
    `  ➜  Server started in "${MODE}" mode at http://localhost:${port}`,
  );
});
