//#region src/form-flash.ts
/**
* The query parameter the flash rides in.
*
* Double-underscored so it cannot collide with a field the author submitted.
*/
const FLASH_PARAM = "__flash";
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
const FLASH_LIMIT = 4096;
/**
* Serialises a flash for the query string.
*
* @param flash - The flash to serialise
* @returns The JSON payload, or `null` when it exceeds {@link FLASH_LIMIT}
*/
const encodeFormFlash = (flash) => {
	const json = JSON.stringify(flash);
	return new TextEncoder().encode(json).length > 4096 ? null : json;
};
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
const decodeFormFlash = (raw) => {
	if (typeof raw !== "string" || raw === "") return null;
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const candidate = parsed;
		if (candidate.errors !== void 0) {
			if (typeof candidate.errors !== "object" || candidate.errors === null || Array.isArray(candidate.errors)) return null;
			for (const messages of Object.values(candidate.errors)) if (!Array.isArray(messages) || !messages.every((message) => typeof message === "string")) return null;
		}
		if (candidate.values !== void 0 && (typeof candidate.values !== "object" || candidate.values === null || Array.isArray(candidate.values))) return null;
		if (candidate.message !== void 0 && typeof candidate.message !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
};
//#endregion
export { FLASH_LIMIT, FLASH_PARAM, decodeFormFlash, encodeFormFlash };

//# sourceMappingURL=flash.mjs.map