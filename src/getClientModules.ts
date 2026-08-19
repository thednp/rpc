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
  let body = "";
  let headers = "{}";
  switch (options.contentType) {
    case "text/plain":
      {
        body = `args[0]`;
        headers = `{ 'Content-Type': 'text/plain' }`;
      }
      break;
    case "application/x-www-form-urlencoded":
      {
        body = `new URLSearchParams(args[0]).toString()`;
        headers = `{ 'Content-Type': 'application/x-www-form-urlencoded' }`;
      }
      break;
    case "multipart/form-data":
      {
        // FormData carries its own multipart content type with a random boundary,
        // so the browser must generate the header (setting it manually strips the boundary)
        body = `args[0]`;
        headers = `{}`;
      }
      break;
    default: {
      body = `JSON.stringify(args)`;
      headers = `{ 'Content-Type': 'application/json' }`;
    }
  }
  // GET requests cannot carry a body: args travel as a JSON query parameter
  if (method === "GET") {
    body = `JSON.stringify(args)`;
    headers = `{}`;
  }

  const output = `
export const ${safeFnEntry} = (...args) => {
  const body = ${body};
  const headers = ${headers};
  const prefix = "${safePrefix}";
  const name = "${safeFnName}";
  const credentials = "${credentials}";
  const method = "${method}";
  return innerModule(body, headers, credentials, prefix, name, method);
}`;

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
      }),
    )
    .join("\n");

  const output = `
// Client-side RPC modules for prefix: ${initialOptions.rpcPrefix}
import { innerModule } from "@thednp/rpc/helpers";
${entries}`;

  return output.trim();
};
