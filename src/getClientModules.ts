/**
 * @module Client module generation.
 */
import type {
  RpcPluginOptionsInternal,
  ServerFunctionOptions,
} from "./types.d.ts";
import { getFunctionsForPrefix } from "./functionsMap.ts";
import {
  validateCredentials,
  validateIdentifier,
  validateMethod,
  validatePathSegment,
} from "./validate.ts";

/**
 * Generates a JavaScript client module string for a single server function.
 * All interpolated values are validated to prevent code injection.
 * @param fnName - Registered RPC function name (validated as path segment)
 * @param fnEntry - Export name used in the generated module (validated as identifier)
 * @param options - Content type, credentials, and RPC prefix settings
 * @returns A string of JavaScript code exporting the client stub
 */
const getModule = (
  fnName: string,
  fnEntry: string,
  options: Partial<ServerFunctionOptions> & {
    contentType: ServerFunctionOptions["contentType"];
    rpcPrefix: string;
  },
): string => {
  // Validate all interpolated strings to prevent code injection
  const safeFnName = validatePathSegment(fnName, "function name");
  const safeFnEntry = validateIdentifier(fnEntry, "export name");
  const safePrefix = validatePathSegment(options.rpcPrefix, "rpcPrefix");
  const credentials = validateCredentials(options.credentials);
  const method = validateMethod(options.method);
  const contentType =
    (options.contentType ?? "application/json") as ServerFunctionOptions[
      "contentType"
    ];

  const opts: string[] = [];
  if (method !== "POST") opts.push(`method: "${method}"`);
  if (credentials !== "same-origin") opts.push(`credentials: "${credentials}"`);
  if (contentType !== "application/json") {
    opts.push(`contentType: "${contentType}"`);
  }
  const optsStr = opts.length ? `, { ${opts.join(", ")} }` : "";

  const output = `
 export const ${safeFnEntry} = getClientStub("${safePrefix}", "${safeFnName}"${optsStr});`;

  return output.trim();
};

/**
 * Generates the complete client-side module bundle by iterating all registered server functions
 * for a specific prefix and producing fetch-based stubs for each. The result is transformed by Vite
 * (or Oxc) during the dev server or production build.
 * @param initialOptions - Plugin options containing rpcPrefix and optional adapter
 * @returns A string of JavaScript code with all client RPC modules and their import dependencies
 */
export const getClientModules = (
  initialOptions: RpcPluginOptionsInternal,
): string => {
  // Validate prefix once at the top level
  validatePathSegment(initialOptions.rpcPrefix, "rpcPrefix");

  // Get functions registered for this specific prefix
  const prefixMap = getFunctionsForPrefix(initialOptions.rpcPrefix);
  const entries = Array.from(prefixMap.entries())
    .filter(([, entry]) => entry.exportName)
    .map(([registeredName, entry]) =>
      getModule(registeredName, entry.exportName!, {
        ...initialOptions,
        ...((entry.options as ServerFunctionOptions) || {}),
      })
    )
    .join("\n");

  const output = `
// Client-side RPC modules for prefix: ${initialOptions.rpcPrefix}
import { getClientStub } from "@thednp/rpc/helpers";
${entries}`;

  return output.trim();
};
