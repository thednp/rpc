import { assertBodySize } from "h3";

// 1 MB in bytes — matches the raw-text cap documented in wiki/best-practices.md.
const MAX_BODY_SIZE = 1024 * 1024;

/**
 * Enforces a maximum request body size.
 *
 * Delegates to h3's `assertBodySize`, which swaps `event.req` for a capped
 * stream so the limit is enforced while the body streams — never fully
 * buffered — and the RPC `readBody` can still consume it afterwards.
 *
 * There are two enforcement paths, and both answer `413 Payload Too Large`:
 *
 * 1. An honest `Content-Length` over the cap trips here, in this `try`, and is
 *    answered below without ever reaching the RPC dispatch.
 * 2. A chunked body (no `Content-Length` to check up front) trips mid-read,
 *    inside the dispatch. The h3 adapter forwards h3's own `4xx` out of its
 *    dispatch `try` for exactly this case — without that, a chunked oversize
 *    body would be reported as a `500`.
 *
 * The explicit `try`/`catch` below therefore covers path 1 deterministically;
 * path 2 is handled by the adapter.
 *
 * @param {import("h3").H3Event} event - the current h3 event
 * @param {() => Promise<unknown> | undefined} next - next middleware in the chain
 * @returns {Promise<{ error: string } | undefined>} the 413 payload when an
 *   honest Content-Length already exceeds the limit, or the result of the next
 *   middleware otherwise
 */
export async function bodyLimit(event, next) {
  try {
    assertBodySize(event, MAX_BODY_SIZE);
  } catch {
    event.res.status = 413;
    return { error: "Payload Too Large" };
  }
  return next();
}
