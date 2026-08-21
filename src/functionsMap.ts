import type { ServerFnEntry } from "./types.d.ts";
import { defaultPrefix, getGlobalPrefix } from "./options.ts";

/**
 * Global symbol under which the shared `serverFunctionsByPrefix` map is stored
 * on `globalThis`. Keeping it on a `Symbol.for` key makes it instance-stable
 * across the bundled entry copies (`index.mjs`, `server.mjs`, `express.mjs`,
 * ...) and dev-server hot reloads, exactly like the request-context storage in
 * `context.ts`. Without this, `scanForServerFiles` (bundled into the plugin)
 * would populate a map copy the adapter middleware could not read.
 */
const functionsMapSymbol = Symbol.for("thednp.rpc.functionsMap");

/**
 * Map of rpcPrefix -> Map of function names -> ServerFnEntry
 * Enables multiple RPC instances with different prefixes to coexist
 * without name collisions.
 */
export const serverFunctionsByPrefix: Map<
  string,
  Map<string, ServerFnEntry>
> = ((globalThis as Record<symbol, Map<string, Map<string, ServerFnEntry>>>)[
  functionsMapSymbol
] ??= new Map());

/**
 * Gets or creates the function map for a specific prefix.
 * @param prefix - The RPC prefix (e.g., "__rpc", "v1:rpc", "admin:rpc")
 * @returns Map of function names to ServerFnEntry for that prefix
 */
export const getFunctionsForPrefix = (
  prefix: string,
): Map<string, ServerFnEntry> => {
  if (!serverFunctionsByPrefix.has(prefix)) {
    serverFunctionsByPrefix.set(prefix, new Map());
  }
  return serverFunctionsByPrefix.get(prefix)!;
};

/**
 * If the requested prefix is the globally configured one and its map is empty
 * but the default map already holds functions (registered before the global
 * was known — e.g. Netlify imports `src/api/server.ts` before
 * `createRPCMiddleware({rpcPrefix})`), copy them. This implements the
 * fallback chain `options.rpcPrefix → global config → default` without
 * requiring `vite` at runtime on serverless.
 */
export const ensurePrefixFromGlobal = (prefix: string): void => {
  const global = getGlobalPrefix();
  if (!global || prefix !== global) return;
  const target = getFunctionsForPrefix(prefix);
  if (target.size > 0) return;
  const def = getFunctionsForPrefix(defaultPrefix);
  if (def.size === 0) return;
  for (const [name, entry] of def) {
    if (!target.has(name)) target.set(name, entry);
  }
};

/**
 * Backward compatibility: default map for the default prefix.
 * Legacy code can still use serverFunctionsMap.set(name, entry).
 */
export const serverFunctionsMap: Map<string, ServerFnEntry> = {
  get: (key: string) => getFunctionsForPrefix(defaultPrefix).get(key),
  set: (key: string, value: ServerFnEntry) =>
    getFunctionsForPrefix(defaultPrefix).set(key, value),
  has: (key: string) => getFunctionsForPrefix(defaultPrefix).has(key),
  delete: (key: string) => getFunctionsForPrefix(defaultPrefix).delete(key),
  clear: () => getFunctionsForPrefix(defaultPrefix).clear(),
  get size() {
    return getFunctionsForPrefix(defaultPrefix).size;
  },
  entries: () => getFunctionsForPrefix(defaultPrefix).entries(),
  keys: () => getFunctionsForPrefix(defaultPrefix).keys(),
  values: () => getFunctionsForPrefix(defaultPrefix).values(),
  forEach: (
    callback: (
      value: ServerFnEntry,
      key: string,
      map: Map<string, ServerFnEntry>,
    ) => void,
  ) => getFunctionsForPrefix(defaultPrefix).forEach(callback),
  [Symbol.iterator]: () =>
    getFunctionsForPrefix(defaultPrefix)[Symbol.iterator](),
} as unknown as Map<string, ServerFnEntry>;
