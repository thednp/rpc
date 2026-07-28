import fs from "node:fs/promises";
import Koa from "koa";
import koaBody from "koa-body";
import serve from "koa-static";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Create Koa app
const app = new Koa();

app.use(koaBody({ jsonLimit: 1024 * 1024 }));

/** @type {import('vite').ViteDevServer | undefined} */
let vite;
if (!isProduction) {
  const { createServer: createViteServer } = await import("vite");
  const { attachVite } = await import("@thednp/rpc/koa");

  vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "custom",
    base,
    root,
  });
  attachVite(app, vite);
} else {
  const { attachRPC } = await import("@thednp/rpc/koa");
  await attachRPC(app);
}

if (isProduction) {
  // Static files - must come BEFORE SSR so assets are served first
  app.use(
    serve(path.join(__dirname, "dist/client"), {
      index: false,
      gzip: true,
      br: true,
      maxage: 31536000,
      immutable: true,
    })
  );
}

// Serve HTML - must come AFTER static files so fallback works
app.use(async (ctx) => {
  try {
    const url = ctx.url.replace(base, "");

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

    ctx.status = 200;
    ctx.type = "text/html";
    ctx.body = html.trim();
  } catch (e) {
    vite?.ssrFixStacktrace(e);
    console.error(e.stack);
    ctx.status = 500;
    ctx.body = "Internal Server Error";
  }
});

// Start http server
app.listen(port, 1, () => {
  console.log(
    `  ➜  Server started in "${MODE}" mode at http://localhost:${port}`,
  );
});
