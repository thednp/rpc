import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig, type ViteDevServer, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { default as rpc } from "@thednp/rpc";
import { createFormFallback } from "./src/lib/form-fallback.ts";
import { parseFormState } from "./src/lib/contact-form.ts";

const RPC_PREFIX = "@demo"

function prerender(): Plugin {
  let devServer: ViteDevServer | undefined;

  const formFallback = createFormFallback({
    rpcPrefix: RPC_PREFIX,
    functionName: "submit-contact",
  });

  return {
    name: "prerender-page",
    enforce: "pre",
    configureServer(server) {
      devServer = server;
      server.middlewares.use(formFallback);
    },
    transformIndexHtml: {
      order: "post",
      async handler(html, ctx) {
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
        const state = parseFormState(ctx.originalUrl?.split("?")[1] ?? "");
        return html.replace("<!-- app-content -->", renderPage(state));
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
