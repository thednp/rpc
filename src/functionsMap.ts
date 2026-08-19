import type { ServerFnEntry } from "./types.d.ts";

/**
 * Map of rpcPrefix -> Map of function names -> ServerFnEntry
 * Enables multiple RPC instances with different prefixes to coexist
 * without name collisions.
 */
export const serverFunctionsByPrefix: Map<
  string,
  Map<string, ServerFnEntry>
> = new Map();

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
 * Backward compatibility: default map for "__rpc" prefix.
 * Legacy code can still use serverFunctionsMap.set(name, entry).
 */
export const serverFunctionsMap: Map<string, ServerFnEntry> = {
  get: (key: string) => getFunctionsForPrefix("__rpc").get(key),
  set: (key: string, value: ServerFnEntry) =>
    getFunctionsForPrefix("__rpc").set(key, value),
  has: (key: string) => getFunctionsForPrefix("__rpc").has(key),
  delete: (key: string) => getFunctionsForPrefix("__rpc").delete(key),
  clear: () => getFunctionsForPrefix("__rpc").clear(),
  get size() {
    return getFunctionsForPrefix("__rpc").size;
  },
  entries: () => getFunctionsForPrefix("__rpc").entries(),
  keys: () => getFunctionsForPrefix("__rpc").keys(),
  values: () => getFunctionsForPrefix("__rpc").values(),
  forEach: (callback: any) => getFunctionsForPrefix("__rpc").forEach(callback),
  [Symbol.iterator]: () => getFunctionsForPrefix("__rpc")[Symbol.iterator](),
} as any;
