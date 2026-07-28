import Fastify from "fastify";
import fs from "node:fs/promises";
import process from "node:process";

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

// Create Fastify server
const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

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
  app.addHook("onRequest", async (request, reply) => {
    const next = () =>
      new Promise((resolve) => {
        vite.middlewares(request.raw, reply.raw, resolve);
      });
    await next();
  });
} else {
  // Load RPC configuration
  const { loadRPCConfig } = await import("@thednp/rpc");
  const { adapter, ...options } = await loadRPCConfig();

  // Register RPC plugin
  await app.register(import("@thednp/rpc/fastify/plugin"), options);

  // Register other middleware
  // await app.register(import("@fastify/compress"));
  // There is a bug in the readable-stream polyfill's interaction with Node 24's native stream pipeline.
  // @fastify/compress config can't fix it, so we use express.
  const compression = (await import("compression")).default;
  app.addHook("onRequest", async (request, reply) => {
    const next = () => new Promise(resolve => {
      compression()(request.raw, reply.raw, resolve);
    });
    await next();
  });

  await app.register(import("@fastify/static"), {
    root: root + "/dist/client/assets",
    prefix: "/assets/",
  });
}

// Serve HTML
app.get("*", async (req, reply) => {
  try {
    const url = req.url.replace(base, "");

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

    reply.status(200).header("Content-Type", "text/html").send(html.trim());
  } catch (e) {
    vite?.ssrFixStacktrace(e);
    console.error(e.stack);
    reply.status(500).send("Internal Server Error");
  }
});

// Start Fastify server
app.listen({ port }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(
    `  ➜  Server started in "${MODE}" mode at http://localhost:${port}`,
  );
});
