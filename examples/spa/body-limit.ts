import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "@thednp/rpc/express";

const MAX_BODY_SIZE = 1024 * 1024;


export const bodyLimit = async (req: IncomingMessage, res: ServerResponse, next: ((r?: Response) => void)) => {
  const { data } = await readBody(req);
  const size = Buffer.byteLength(
    typeof data === "string" ? data : JSON.stringify(data)
  );
  if (size > MAX_BODY_SIZE) {
    res.statusCode = 413;
    res.end("Payload Too Large");
    return;
  }
  req.body = data as never; // pass to RPC middleware
  next();
};
