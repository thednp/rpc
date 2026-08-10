import { assertBodySize } from "h3";

// 1 MB in bytes — matches the raw-text cap documented in wiki/best-practices.md.
const MAX_BODY_SIZE = 1024 * 1024;

/**
 * Enforces a maximum request body size before the RPC middleware runs.
 *
 * Delegates to h3's `assertBodySize`, which swaps `event.req` for a capped
 * stream so the limit is enforced while the body is streamed — never fully
 * buffered — and the RPC `readBody` can still consume it afterwards. Oversized
 * bodies reject with `413 Payload Too Large` as a JSON payload.
 *
 * @param {import("h3").H3Event} event - the current h3 event
 * @param {() => Promise<unknown> | undefined} next - next middleware in the chain
 * @returns {Promise<{ error: string } | undefined>} the 413 payload when the
 *   body exceeds the limit, or the result of the next middleware otherwise
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
