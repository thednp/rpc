import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_SIZE = 1024 * 1024;

type Request = IncomingMessage & {
  body?: unknown;
};

/**
 * Streaming body-limit middleware for the demo's raw `node:http` and
 * Netlify entry points (no framework body parser runs before this).
 *
 * The cap is enforced while the request stream is being read, so an
 * oversized body is rejected with 413 without ever being fully buffered
 * in memory. A `Content-Length` fast-path rejects obviously oversized
 * requests before the stream is touched.
 *
 * When the body fits, it is parsed (mirroring `@thednp/rpc/express`'s
 * `readBody` semantics) and stashed on `req.body` for the RPC middleware.
 */
export const bodyLimit = (
  req: Request,
  res: ServerResponse,
  next: (r?: Response) => void,
): void => {
  // Fast path: an advertised Content-Length over the cap needs no streaming.
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_SIZE) {
    res.statusCode = 413;
    res.end("Payload Too Large");
    return;
  }

  // If the stream was already consumed elsewhere, let the next middleware decide.
  if (req.readableEnded) {
    next();
    return;
  }

  let size = 0;
  let capped = false;
  const chunks: Buffer[] = [];

  req.on("data", (chunk: Buffer) => {
    if (capped) return;

    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      capped = true;
      chunks.length = 0; // drop what was buffered
      req.removeAllListeners("data");
      res.statusCode = 413;
      res.end("Payload Too Large");
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (capped) return;

    const body = Buffer.concat(chunks).toString();
    const incomingType = req.headers["content-type"]?.toLowerCase() || "";
    const isMultipart = incomingType.includes("multipart/form-data");
    const isUrlEncoded = incomingType.includes("urlencoded");
    let data: unknown = body;
    if (isMultipart) {
      // Mirror @thednp/rpc/express readBody's streaming semantics: multipart
      // bodies are stashed as { raw: body } for the RPC middleware/server fn.
      data = { raw: body };
    } else if (isUrlEncoded) {
      data = Object.fromEntries(new URLSearchParams(body));
    } else {
      try {
        data = JSON.parse(body);
      } catch {
        // leave as text; RPC handling will produce a generic 500
      }
    }
    req.body = data;
    next();
  });
};