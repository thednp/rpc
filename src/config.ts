/**
 * Vite-free configuration helpers.
 *
 * This module intentionally has zero runtime dependencies (not even on `vite`),
 * so `rpc.config.ts` files that import it stay safe to load in serverless
 * bundles where Vite is not installed. Importing the main plugin entry
 * (`@thednp/rpc`) instead would drag Vite into every server-side consumer.
 */
import type { RpcPluginOptions } from "./types.d.ts";
import { defaultRPCOptions } from "./options.ts";

/**
 * Type-safe helper to create an RPC configuration object.
 * Merges the provided partial config over the built-in defaults,
 * skipping explicitly `undefined` values.
 * @param uniConfig - System-wide RPC configuration overrides
 * @returns Complete RPC plugin options with defaults applied
 */
export const defineConfig: (
  c: Partial<RpcPluginOptions>,
) => RpcPluginOptions = (uniConfig: Partial<RpcPluginOptions>) => {
  const merged: RpcPluginOptions & Record<string, string> = {
    ...defaultRPCOptions,
  };
  for (const [key, value] of Object.entries(uniConfig)) {
    // istanbul ignore else
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
};
