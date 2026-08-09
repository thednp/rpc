import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig, type ViteDevServer, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { default as rpc } from "@thednp/rpc";
import { createFormFallback } from "./src/lib/form-fallback.ts";
import { parseFormState } from "./src/lib/contact-form.ts";

const RPC_PREFIX = "@demo"

/** Markers kept in the built index.html so preview can re-render on demand. */
const APP_CONTENT_START = "<!-- app-content -->";
const APP_CONTENT_END = "<!-- /app-content -->";
const APP_CONTENT_REGEX = /<!-- app-content -->[\s\S]*?<!-- \/app-content -->/;

function prerender(): Plugin {
  let devServer: ViteDevServer | undefined;
  let builtTemplate: string | undefined;

  const formFallback = createFormFallback({
    rpcPrefix: RPC_PREFIX,
    functionName: "submit-contact",
  });

  const loadRender = async () => {
    let renderPage: (state?: unknown) => string;
    if (devServer) {
      const mod = await devServer.ssrLoadModule("/src/render.ts");
      renderPage = mod.renderPage;
    } else {
      const url = pathToFileURL(resolve("src/render.ts"));
      url.searchParams.set("t", String(Date.now()));
      const mod = await import(/* @vite-ignore */ url.href);
      renderPage = mod.renderPage;
    }
    return renderPage;
  };

  return {
    name: "prerender-page",
    enforce: "pre",
    configureServer(server) {
      devServer = server;
      server.middlewares.use(formFallback);
    },
    configurePreviewServer(server) {
      // In `vite preview` the app shell in dist/index.html is baked at build
      // time, so the transformIndexHtml hook never runs per request. Re-render
      // just the app-content region (kept between the markers by the build
      // hook) to recover nojs form state from the URL query — asset URLs in the
      // built shell stay untouched.
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const accept = (req.headers.accept ?? "").toLowerCase();
        const isDocumentNav =
          req.method?.toUpperCase() === "GET" &&
          url.pathname === "/" &&
          accept.includes("text/html");
        if (!isDocumentNav) return next?.();

        try {
          if (!builtTemplate) {
            builtTemplate = readFileSync(resolve("dist/index.html"), "utf8");
          }
          const renderPage = await loadRender();
          const state = parseFormState(url.search.replace(/^\?/, ""));
          const content = `${APP_CONTENT_START}${renderPage(state)}${APP_CONTENT_END}`;
          const html = builtTemplate.replace(APP_CONTENT_REGEX, content);
          res.setHeader("Content-Type", "text/html");
          res.end(html);
        } catch (err) {
          console.error(String(err));
          res.statusCode = 500;
          res.end("Internal Server Error");
        }
      });
    },
    transformIndexHtml: {
      order: "post",
      async handler(html, ctx) {
        const renderPage = await loadRender();
        const state = parseFormState(ctx.originalUrl?.split("?")[1] ?? "");
        const content = `${APP_CONTENT_START}${renderPage(state)}${APP_CONTENT_END}`;
        return html.replace("<!-- app-content -->", content);
      },
    },
  };
};

export default defineConfig(async (config) => {
  const proxyPort = 3000;

  return {
    plugins: [prerender(), tailwindcss() as any, rpc({ rpcPrefix: RPC_PREFIX })],
    preview: {
      strictPort: true,
      port: 5173,
      proxy: {
        [`/${RPC_PREFIX}`]: {
          target: `http://localhost:${proxyPort}`,
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});
