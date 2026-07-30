// Internal type that accepts all adapters
interface RpcPluginOptionsInternal {
  rpcPrefix: string;
  adapter?: string | undefined;
}

import type { ServerFunctionOptions } from "./types.d.ts";
import { serverFunctionsMap } from "./functionsMap.ts";
import {
  validateCredentials,
  validateIdentifier,
  validatePathSegment,
} from "./validate.ts";

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
