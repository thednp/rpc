export const startProxyServer = async (port: number = 3000) => {
  const { createServer } = await import("node:http");
  const { bodyLimit } = await import("./body-limit.ts");
  const colors = (await import("picocolors")).default;
  const { loadRPCConfig } = await import("@thednp/rpc");
  const { createRPCMiddleware } = await import("@thednp/rpc/express");
  const rpcConfig = await loadRPCConfig();
  const rpc = createRPCMiddleware(rpcConfig);
  const stack = [bodyLimit, rpc];

  const httpServer = createServer(async (req, res) => {
    for (let i = 0; i < stack.length; i++) {
      const middleware = stack[i]
      const next = () =>
        new Promise((resolve) => {
          middleware(req, res, resolve);
        });
      await next();
      if (res.writableEnded) return;
    }
    res.statusCode = 404;
    res.end("Not Found");
  });

  httpServer.listen(port, () => {
    console.log(
      `  ${colors.green("➜")}  ${colors.bold("RPC Backend")}: ${colors.cyan(
        "http://localhost:" + colors.bold(port + "/"),
      )}`,
    );
  });
};

if (import.meta.main) startProxyServer();
