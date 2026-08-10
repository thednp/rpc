import fs from "node:fs/promises";
import path from "node:path";
import { serveStatic as serveStaticH3 } from "h3/node";

const base = process.env.BASE || "/";
const root = process.env.ROOT || process.cwd();

// Static assets — served from dist/client with h3 serveStatic; missing
// files fall through to the SSR handler below.
const staticDir = path.join(root, "dist/client");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Serves built static assets from `dist/client` with `Content-Length`,
 * `Last-Modified`, `ETag`/`Cache-Control`, scale of 1 year immutable.
 *
 * Runs after RPC middleware so asset requests never reach server functions.
 * Root and base paths fall through (return `undefined`) to let the SSR
 * handler render the app shell, and unknown files fall through to the
 * 404/SSR fallback.
 *
 * @param {import("h3").H3Event} event - the current h3 event
 * @returns {Promise<import("h3").HTTPResponse | undefined>} a response with the
 *   file contents, or `undefined` to fall through to the next middleware
 */
export async function serveStatic(event) {
  const { pathname } = event.url;
  if (pathname === "/" || pathname === base) return undefined;

  return serveStaticH3(event, {
    getMeta: async (id) => {
      try {
        const stat = await fs.stat(path.join(staticDir, id));
        if (!stat.isFile()) return undefined;
        return {
          type: MIME[path.extname(id)] || "application/octet-stream",
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        };
      } catch {
        return undefined;
      }
    },
    getContents: async (id) => {
      try {
        return await fs.readFile(path.join(staticDir, id));
      } catch {
        return undefined;
      }
    },
    headers: { "cache-control": "public, max-age=31536000, immutable" },
    indexNames: [],
    fallthrough: true,
  });
}
