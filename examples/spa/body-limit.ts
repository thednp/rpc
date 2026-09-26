import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_SIZE = 1024 * 1024;
// Past the cap we stop buffering but keep draining (discarding) so the request
// completes and the 413 is actually deliverable — closing a socket with unread
// request data makes Node emit RST, and the client never learns why it failed.
// The drain ceiling stops that discard from becoming an unbounded slowloris;
// past it the connection is cut, so pathologically large uploads see a reset
// rather than a 413. Sized to cover ordinary "oops, too big" submissions.
const MAX_DRAIN_SIZE = MAX_BODY_SIZE * 32;

type Request = IncomingMessage & {
  body?: unknown;
};

/**
 * Body-size limit for the raw `node:http` SPA proxy.
 *
 * The cap is enforced **while streaming**, not after buffering: chunks are
 * measured as they arrive and nothing beyond the limit is ever retained, so an
 * oversized upload is never fully resident in memory. Buffering first and
 * measuring afterwards (the obvious `readBody`-then-check shape) provides no
 * protection against memory exhaustion at all, which is the one thing this
 * middleware exists to do.
 *
 * Register it **before** the RPC middleware; the parsed body is handed over on
 * `req.body` for the middleware's pre-parsed-body path to pick up.
 */
export const bodyLimit = async (
  req: Request,
  res: ServerResponse,
  next: (r?: Response) => void,
) => {
  const chunks: Buffer[] = [];
  let size = 0;
  let drained = 0;
  let tooLarge = false;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      drained += chunk.length;
      if (tooLarge) {
        if (drained > MAX_DRAIN_SIZE) {
          // Client is still pushing long after the verdict — stop reading and
          // let the connection go rather than discard indefinitely.
          cleanup();
          req.destroy();
          resolve();
        }
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        tooLarge = true;
        chunks.length = 0; // release what we hold; the verdict is already decided
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });

  if (tooLarge) {
    res.statusCode = 413;
    res.setHeader("Connection", "close");
    res.end("Payload Too Large", () => req.destroy());
    return;
  }

  const raw = Buffer.concat(chunks).toString();
  const contentType = (req.headers["content-type"] ?? "").toLowerCase();

  // Mirror the adapters' `readBody` parsing so the RPC middleware receives the
  // same shape it would have produced itself.
  let parsed: unknown = raw;
  if (contentType.includes("multipart/form-data")) {
    parsed = { raw };
  } else if (contentType.includes("urlencoded")) {
    parsed = Object.fromEntries(new URLSearchParams(raw));
  } else if (contentType.includes("json")) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }

  req.body = parsed;
  next();
};
