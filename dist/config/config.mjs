const defaultRPCOptions = {
	rpcPrefix: "__rpc",
	adapter: "express",
	serverFiles: "exact",
	scanRoot: void 0
};
//#endregion
//#region src/config.ts
/**
* Type-safe helper to create an RPC configuration object.
* Merges the provided partial config over the built-in defaults,
* skipping explicitly `undefined` values.
* @param uniConfig - System-wide RPC configuration overrides
* @returns Complete RPC plugin options with defaults applied
*/
const defineConfig = (uniConfig) => {
	const merged = { ...defaultRPCOptions };
	for (const [key, value] of Object.entries(uniConfig)) if (value !== void 0) merged[key] = value;
	return merged;
};
//#endregion
export { defineConfig };

//# sourceMappingURL=config.mjs.map