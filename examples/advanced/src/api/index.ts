// Client + SSR surface: only the public-prefix functions are re-exported.
// The admin-prefix functions in `admin.server.ts` are registered into the
// `admin:rpc` map by the scan (glob mode) and dispatched through the
// `admin:rpc` middleware — they are never part of the shared index, so the
// client transform (which generates stubs only for the config prefix) never
// re-exports them here and there is no ambiguous star-export collision.
// Auth helpers (login/logout/me) are public:rpc so they are re-exported.
// Use named re-exports to avoid Rolldown's ambiguous star-export error when
// multiple files share the same prefix — each file's virtual module contains
// all prefix functions.
export { add, getServerTime, getUser, sayHi } from "./public.server";
export { login, logout, me } from "./auth.server";
export type * from "./types";
