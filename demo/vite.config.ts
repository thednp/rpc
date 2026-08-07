import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig, type ViteDevServer, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { default as rpc } from "@thednp/rpc";

const RPC_PREFIX = "@demo"

function prerender(): Plugin {
  let devServer: ViteDevServer | undefined;

  return {
    name: "prerender-page",
    configureServer(server) {
      devServer = server;
    },
    transformIndexHtml: {
      order: "post",
      async handler(html) {
        let renderPage: () => string;
        if (devServer) {
          const mod = await devServer.ssrLoadModule("/src/render.ts");
          renderPage = mod.renderPage;
        } else {
          const url = pathToFileURL(resolve("src/render.ts"));
          url.searchParams.set("t", String(Date.now()));
          const mod = await import(/* @vite-ignore */ url.href);
          renderPage = mod.renderPage;
        }
        return html.replace("<!-- app-content -->", renderPage());
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
