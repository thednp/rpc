import fs from "node:fs/promises";
import { H } from "./http-express.ts";
import type { ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RpcPluginOptions } from "@thednp/rpc";

// Constants
const isProduction = process.env.NODE_ENV === "production";
const MODE = process.env.NODE_ENV || "development";
const port = Number(process.env?.PORT) || 5173;
const base = process.env.BASE || "/";
const root = process.env.ROOT || process.cwd();
const MAX_BODY_SIZE = 1024 * 1024;

// Cached production assets
const templateHtml = isProduction
  ? await fs.readFile("./dist/client/index.html", "utf-8")
  : "";

// Create http server using H()
const app = H();

// Body limit middleware for RPC requests (prefix-gated)
const { createMiddleware, readBody } = await import("@thednp/rpc/express");
const { loadRPCConfig } = await import("@thednp/rpc");
const rpcConfig = await loadRPCConfig();

app.use(createMiddleware({
  rpcPrefix: rpcConfig.rpcPrefix,
  handler: async (req: IncomingMessage, res: ServerResponse, next) => {
    const { data } = await readBody(req);
    const size = Buffer.byteLength(
      typeof data === "string" ? data : JSON.stringify(data)
    );
    if (size > MAX_BODY_SIZE) {
      res.statusCode = 413;
      res.end("Payload Too Large");
      return;
    }
    (req as any).body = data;
    next();
  },
}));

// Add Vite or respective production middlewares
let vite: ViteDevServer;
let config: RpcPluginOptions

if (!isProduction) {
  const { createServer } = await import("vite");
  const { attachVite } = await import("@thednp/rpc/express");

  vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    base,
    root,
  });
  attachVite(app as never, vite);
} else {
  const { attachRPC } = await import("@thednp/rpc/express");
  await attachRPC(app as never);

  // Static files - must come BEFORE HTML middleware
  const { loadRPCConfig } = await import("@thednp/rpc");
  config = await loadRPCConfig();

  // Static files from dist/client
  app.use(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || "/";
    
    // Skip RPC paths and root - those are handled by SSR
    if (url.startsWith(config.rpcPrefix) || url === "/") {
      return; 
    }

    // Try to serve static file
    let filePath = url;
    filePath = filePath.split("?")[0];
    
    // Security: prevent directory traversal
    if (filePath.includes("..")) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    try {
      const distDir = "./dist/client";
      const fullPath = distDir + filePath;
      const stat = await fs.stat(fullPath);
      
      if (stat.isDirectory()) {
        // Try index.html in directory
        const indexPath = fullPath + "/index.html";
        const content = await fs.readFile(indexPath);
        res.setHeader("Content-Type", "text/html");
        res.end(content);
      } else {
        // Serve the file
        const ext = (filePath.split(".").pop() || "") as keyof typeof contentType;
        const contentType = {
          html: "text/html",
          js: "application/javascript",
          css: "text/css",
          json: "application/json",
          jpeg: "image/jpeg",
          jpg: "image/jpeg",
          png: "image/png",
          webp: "image/webp",
          svg: "image/svg+xml",
          ico: "image/x-icon",
        };
        const content = await fs.readFile(fullPath);
        res.setHeader("Content-Type", contentType[ext] || "text/plain");
        res.end(content);
      }
    } catch {
      // File not found, continue to next middleware
    }
  });
}

// Serve HTML (SSR) - comes AFTER static files
app.use(async (req: IncomingMessage, res: ServerResponse) => {
  // Skip non-GET
  if (req.method !== "GET") return;
  
  // Skip if response already handled
  if (res.headersSent || res.writableEnded) return;
  
  const url = (req.url || "/").split("?")[0];

  const { loadRPCConfig } = await import("@thednp/rpc");
  config = await loadRPCConfig();
  
  // Skip RPC paths
  if (url.startsWith(config.rpcPrefix)) return;

  try {
    let template: string;
    let render: typeof import('./src/entry-server.ts').render;
    if (!isProduction) {
      template = await fs.readFile("./index.html", "utf-8");
      template = await vite.transformIndexHtml(url, template);
      render = (await vite.ssrLoadModule("/src/entry-server.ts")).render;
    } else {
      template = templateHtml;
      render = (await import("./dist/server/entry-server.js")).render as never;
    }

    const rendered = await render(url);
    const html = template
      .replace(`<!--app-html-->`, rendered.html ?? "");

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html");
    res.end(html.trim());
  } catch (e: unknown) {
    vite?.ssrFixStacktrace(e as Error);
    console.error((e as Error).stack);
    res.statusCode = 500;
    res.end("Internal Server Error");
  }
});

// Start http server
app.listen(port, () => {
  console.log(
    `  ➜  Server started in "${MODE}" mode at http://localhost:${port}`,
  );
});
