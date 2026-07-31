/**
 * Internal plugin options accepted by `getClientModules`.
 */
interface RpcPluginOptionsInternal {
  /** RPC endpoint prefix (e.g. "__rpc") */
  rpcPrefix: string;
  /** Framework adapter name */
  adapter?: string | undefined;
}

import type { ServerFunctionOptions } from "./types.d.ts";
import { serverFunctionsMap } from "./functionsMap.ts";
import {
  validateCredentials,
  validateIdentifier,
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
  let body = "";
  let headers = "{}";
  switch (options.contentType) {
    case "text/plain":
      {
        body = `args[0]`;
        headers = `{ 'Content-Type': 'text/plain' }`;
      }
      break;
    default: {
      body = `JSON.stringify(args)`;
      headers = `{ 'Content-Type': 'application/json' }`;
    }
  }

  const output = `
export const ${safeFnEntry} = (...args) => {
  const body = ${body};
  const headers = ${headers};
  const prefix = "${safePrefix}";
  const name = "${safeFnName}";
  const credentials = "${credentials}";
  return innerModule(body, headers, credentials, prefix, name);
}`;

  return output.trim();
};

/**
 * Generates the complete client-side module bundle by iterating all registered server functions
 * and producing fetch-based stubs for each. The result is transformed by Vite (or Oxc) during
 * the dev server or production build.
 * @param initialOptions - Plugin options containing rpcPrefix and optional adapter
 * @returns A string of JavaScript code with all client RPC modules and their import dependencies
 */
export const getClientModules = (
  initialOptions: RpcPluginOptionsInternal,
): string => {
  // Validate prefix once at the top level
  validatePathSegment(initialOptions.rpcPrefix, "rpcPrefix");

  return `
// Client-side RPC modules
import { innerModule } from "@thednp/rpc/helpers";
${
    Array.from(serverFunctionsMap.entries())
      .filter(([, entry]) => entry.exportName)
      .map(([registeredName, entry]) =>
        getModule(registeredName, entry.exportName!, {
          ...initialOptions,
          ...((entry.options as ServerFunctionOptions) || {}),
        })
      )
      .join("\n")
  }
`.trim();
};
