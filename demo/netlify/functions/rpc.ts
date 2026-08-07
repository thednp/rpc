// Netlify Function: RPC backend for the demo app.
// Mirrors ../server.ts (demo/server.ts) but runs as a serverless function.
// The redirect "/@demo/*" → "/.netlify/functions/rpc/:splat" forwards
// requests here, and we restore the original "/@demo/..." path before
// the RPC middleware sees it.
import serverless from "serverless-http";
import { createRPCMiddleware } from "@thednp/rpc/express";
import { bodyLimit } from "../../body-limit.ts";

import "../../src/api/server.ts";

const rpc = createRPCMiddleware({ rpcPrefix: "@demo" });
const stack = [bodyLimit, rpc];

const app = (req: any, res: any, next: any) => {
  const marker = "/.netlify/functions/rpc/";
  const index = req.url.indexOf(marker);
  if (index !== -1) {
    req.url = "/@demo/" + req.url.slice(index + marker.length);
  }
  // serverless-http sets req.body to the raw event body string, which
  // readBody would mistake for a pre-parsed body — force the stream path.
  delete req.body;
  let i = 0;
  const loop = () => {
    const middleware = stack[i++];
    if (!middleware) return next?.();
    middleware(req, res, loop);
  };
  loop();
};

export const handler = serverless(app);
