// Internal type that accepts all adapters
interface RpcPluginOptionsInternal {
  rpcPreffix: string;
  adapter?: string | undefined;
}

import type { ServerFunctionOptions } from "./types.d.ts";
import { serverFunctionsMap } from "./functionsMap.ts";

// Safe identifier pattern: must match JS identifier rules (letters, digits, $, _)
// and must not contain regex metacharacters or template literal interpolation.
const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// Safe URL path segment: identifier characters plus "/" for nested prefixes like "api/rpc"
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_$][A-Za-z0-9_$/-]*$/;

function validateIdentifier(name: string, label: string): string {
  // istanbul ignore if
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(
      `Invalid ${label}: "${name}" must match /^[A-Za-z_$][A-Za-z0-9_$]*$/`,
    );
  }
  return name;
}

function validatePathSegment(segment: string, label: string): string {
  // istanbul ignore if
  if (!SAFE_PATH_SEGMENT.test(segment)) {
    throw new Error(
      `Invalid ${label}: "${segment}" must match /^[A-Za-z0-9_$][A-Za-z0-9_$/-]*$/`,
    );
  }
  return segment;
}

const getModule = (
  fnName: string,
  fnEntry: string,
  options: Partial<ServerFunctionOptions> & {
    contentType: ServerFunctionOptions["contentType"];
    rpcPreffix: string;
  },
) => {
  // Validate all interpolated strings to prevent code injection
  const safeFnName = validatePathSegment(fnName, "function name");
  const safeFnEntry = validateIdentifier(fnEntry, "export name");
  const safePrefix = validatePathSegment(options.rpcPreffix, "rpcPreffix");

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
  const preffix = "${safePrefix}";
  const name = "${safeFnName}";
  return innerModule(body, headers, preffix, name);
}`;

  return output.trim();
};

export const getClientModules = (initialOptions: RpcPluginOptionsInternal) => {
  // Validate prefix once at the top level
  validatePathSegment(initialOptions.rpcPreffix, "rpcPreffix");

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
