// server.js
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { H3 } from "h3";
import { toNodeListener, serveStatic } from "h3/node";
import { loadRPCConfig } from "@thednp/rpc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  const { createRPCMiddleware } = await import("@thednp/rpc/h3");
  const { adapter: _adapter, ...options } = rpcConfig;

  // Body size limit — enforced before RPC middleware (defense-in-depth)
  app.use(async (event, next) => {
    const contentLength = event.req.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > 1024 * 1024) {
      event.res.status = 413;
      return { error: "Payload Too Large" };
    }
    return next();
  });

  app.use(createRPCMiddleware(options));

  // Static assets — served from dist/client with h3 serveStatic; missing
  // files fall through to the SSR handler below.
  const staticDir = path.join(__dirname, "dist/client");
  const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };

  app.use(async (event) => {
    const { pathname } = event.url;
    if (pathname === "/" || pathname === base) return undefined;

    return serveStatic(event, {
      getMeta: async (id) => {
        try {
          const stat = await fs.stat(path.join(staticDir, id));
          if (!stat.isFile()) return undefined;
          return {
            type: MIME[path.extname(id)] || "application/octet-stream",
            size: stat.size,
            mtime: stat.mtime.toISOString(),
          };
        } catch {
          return undefined;
        }
      },
      getContents: async (id) => {
        try {
          return await fs.readFile(path.join(staticDir, id));
        } catch {
          return undefined;
        }
      },
      headers: { "cache-control": "public, max-age=31536000, immutable" },
      indexNames: [],
      fallthrough: true,
    });
  });
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
