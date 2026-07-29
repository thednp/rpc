import { defineConfig } from "vite";
import { default as rpc, loadRPCConfig } from "@thednp/rpc";

export default defineConfig(async (config) => {
  const rpcConfig = await loadRPCConfig();
  const proxyPort = 3000;

  if (config.isPreview) {
    const { startProxyServer } = await import("./server.ts");
    await startProxyServer(proxyPort);
  }

  return {
    plugins: [rpc()],
    preview: {
      port: 5173,
      proxy: {
        [`/${rpcConfig.rpcPrefix}`]: {
          target: `http://localhost:${proxyPort}`,
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});
