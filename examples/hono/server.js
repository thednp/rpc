// server.js
import fs from "node:fs/promises";
import { Hono } from "hono";
import { bodyLimit } from 'hono/body-limit'
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { loadRPCConfig } from "@thednp/rpc";

const isProduction = process.env.NODE_ENV === "production";
const MODE = process.env.NODE_ENV || "development";
const port = Number(process.env.PORT) || 5173;
const base = process.env.BASE || "/";
const root = process.env.ROOT || process.cwd();
const rpcConfig = await loadRPCConfig();

const templateHtml = isProduction
  ? await fs.readFile("./dist/client/index.html", "utf-8")
  : "";

const app = new Hono();

app.use('*', bodyLimit({ maxSize: 1024 * 1024 })) // 1MB limit

let vite;
if (!isProduction) {
  const { createServer } = await import("vite");
  const { viteMiddleware } = await import("@thednp/rpc/hono");
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    base,
    root,
  });

  app.use(viteMiddleware(vite));
} else {
  const { createRPCMiddleware } = await import("@thednp/rpc/hono");
  const options = rpcConfig;
  // Since 0.4.0 the cross-origin check is on by default (`origin: "self"`), so a
  // request with no `Origin` and no `Sec-Fetch-Site` is refused. These example
  // servers are meant to be poked with `curl` and the no-JS form fallback,
  // which send neither header — hence `allowHeaderless: true`. A real deployment
  // should leave it off and name its public origins instead.
  app.use(createRPCMiddleware({ allowHeaderless: true, ...options }));

  // Serve static assets
  app.use(
    `${base}assets/*`,
    serveStatic({
      root: "dist/client",
    }),
  );
}

app.get("*", async (c, next) => {
  const path = c.req.path;

  try {
    const url = base === "/" ? path : path.replace(new RegExp(`^${base}`), "");
    let template;
    let render;

    if (!isProduction) {
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

    return c.html(html.trim(), 200, { "Content-Type": "text/html" });
  } catch (e) {
    vite?.ssrFixStacktrace(e);
    console.error(e.stack);
    return c.text("Internal Server Error", 500);
  }
});

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(
      `  ➜  Server started in "${MODE}" mode at http://localhost:${info.port}`,
    );
  },
);

export default app;
