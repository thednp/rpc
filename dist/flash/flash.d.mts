//#region src/form-flash.d.ts
/**
 * @module The flash codec, in a form both a server and a browser can import.
 *
 * A no-JS form fallback has to be readable in **two** places: the server, which
 * renders the page after the Post/Redirect/Get, and the client, which rehydrates
 * the form and refills it. So the codec cannot live behind a server-only entry
 * point — the sibling `form-fallback.ts` is server-only because it pulls in
 * `bodyKind` and `isRPCError`, which are, and this module does not.
 *
 * The split is by dependency rather than by convenience: everything here is pure
 * and touches nothing but `JSON`. Import it from `@thednp/rpc/flash` on either
 * side of the wire.
 */
/**
 * The outcome of a native form submission, as it travels in the redirect URL.
 */
export interface FormFlash {
  /**
   * Field-level messages, keyed by rendered path (`email`, `address.city`), so
   * the re-rendered form can mark each input without re-deriving anything.
   */
  readonly errors?: Record<string, string[]>;
  /**
   * Submitted values to replay back into the form, so a rejected submission does
   * not clear what the user typed.
   *
   * Only ever what the author explicitly allowed — see `pickReplayable` in
   * `@thednp/rpc/server`. A password is a secret with a lifetime, and a redirect
   * URL is not a place to put one: it reaches browser history, the `Referer` of
   * the next navigation, and every access log in between.
   */
  readonly values?: Record<string, unknown>;
  /**
   * A general, author-written message. Taken from an `RPCError`'s `hint` when it
   * has one, because a hint is written knowing it will be read.
   */
  readonly message?: string;
}
/**
 * The query parameter the flash rides in.
 *
 * Double-underscored so it cannot collide with a field the author submitted.
 */
export declare const FLASH_PARAM = "__flash";
/**
 * The largest serialized flash rpc will put in a URL: 4 KiB.
 *
 * A bound on size, not on confidentiality — the confidentiality rule is
 * structural, in `pickReplayable`. Past this the flash is dropped rather than
 * truncated, so the redirect still happens and the form re-renders empty instead
 * of the user receiving a URL nothing will tolerate.
 *
 * 4 KiB rather than 8 because the flash URL is then **requested by the browser**,
 * so it lands in a request line. nginx's default `large_client_header_buffers 4 8k`
 * requires the request line to fit in a single 8 KiB buffer, so a flash at 8 KiB
 * plus a base path and query exceeds it and the user gets a `414` instead of
 * their form. Half that leaves headroom under the common proxy ceiling.
 *
 * The realistic case is far smaller — a message and a few field paths is a few
 * hundred bytes, and twenty fields with generous hints is around 2 KiB — so this
 * costs nothing in practice.
 */
export declare const FLASH_LIMIT = 4096;
/**
 * Serialises a flash for the query string.
 *
 * @param flash - The flash to serialise
 * @returns The JSON payload, or `null` when it exceeds {@link FLASH_LIMIT}
 */
export declare const encodeFormFlash: (flash: FormFlash) => string | null;
/**
 * Parses a flash back out of a query string, for SSR to replay it and for the
 * client to rehydrate from.
 *
 * Total by design: anything unparseable is `null` rather than a throw, because
 * this runs during a page render and a malformed query parameter is not a good
 * reason a page fails to render. A parsed object is also checked for the flash's
 * container shapes before it is trusted as a `FormFlash`.
 *
 * That check is structural, not a substitute for treating URL input as untrusted:
 * callers must still whitelist the fields they render and escape the strings
 * they emit.
 *
 * @param raw - The raw parameter value, or `undefined` when absent
 * @returns The flash, or `null` when absent, malformed, or structurally invalid
 */
export declare const decodeFormFlash: (raw: string | null | undefined) => FormFlash | null;
//#endregion
//# sourceMappingURL=flash.d.mts.map