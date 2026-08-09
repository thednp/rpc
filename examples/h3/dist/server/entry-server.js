import { AsyncLocalStorage } from "node:async_hooks";
import * as v from "valibot";
//#region ../../dist/server/server.mjs
var serverFunctionsMap = /* @__PURE__ */ new Map();
var OPERATION_ABORTED = "Operation aborted";
var defaultServerFnOptions = {
	contentType: "application/json",
	credentials: "same-origin",
	method: "POST"
};
/**
* Creates a server-side RPC function.
* Registers the function in the server functions map and returns a client-compatible
* wrapper that exposes `data` (Promise) and `cancel` (function) for request lifecycle control.
* @param name - Unique identifier used by the RPC router to dispatch requests
* @param handler - The actual implementation receiving an AbortSignal followed by JSON-serializable arguments
* @param fnOptions - Optional contentType and credentials settings
* @returns A client stub with `data` promise and `cancel` method, auto-registered in the server map
*/
function createServerFunction(name, handler, fnOptions = {}) {
	const options = Object.assign({}, defaultServerFnOptions, fnOptions);
	const wrappedFunction = (...args) => {
		const controller = new AbortController();
		const cancel = (reason) => controller.abort(reason);
		const fetcher = async () => {
			if (controller.signal.aborted) throw new Error(OPERATION_ABORTED);
			return await handler(controller.signal, ...args);
		};
		return {
			data: fetcher(),
			cancel
		};
	};
	Object.defineProperties(wrappedFunction, {
		name: {
			value: name,
			enumerable: true,
			configurable: false
		},
		options: {
			value: options,
			enumerable: true,
			configurable: false
		}
	});
	serverFunctionsMap.set(name, {
		name,
		handler: wrappedFunction,
		options
	});
	return wrappedFunction;
}
/** @module Server-side request context. Exports the `RequestEvent` shape, `provideRequestContext` to establish it around a dispatch, `getRequestContext` to read it from anywhere inside the async tree, and `redirect` for framework-level redirects. Never import this module in client code — it is server-only. */
/**
* Global symbol under which the shared `AsyncLocalStorage` instance is stored
* on `globalThis`. Keeping it on a `Symbol.for` key makes it instance-stable
* across module copies and dev-server hot reloads, mirroring
* `solid-js/web`'s own request-context storage.
*/
var requestContextSymbol = Symbol.for("thednp.rpc.requestContext");
globalThis[requestContextSymbol] ??= new AsyncLocalStorage();
//#endregion
//#region src/util/helpers.ts
/**
* @see https://github.com/thednp/shorty/blob/master/src/misc/normalizeValue.ts
*/
var normalizeValue = (value) => {
	if (["true", true].includes(value)) return true;
	if (["false", false].includes(value)) return false;
	if ([
		"null",
		"",
		null,
		void 0
	].includes(value)) return null;
	if (value !== "" && !Number.isNaN(+value)) return Number(value);
	return value;
};
//#endregion
//#region src/api/server.ts
var sayHi = createServerFunction("say-hi", async (signal, name) => {
	signal?.throwIfAborted();
	await new Promise((res) => setTimeout(res, 1500));
	signal?.throwIfAborted();
	return `Hello ${name}!`;
}, { contentType: "text/plain" });
var AddSchema = v.object({
	a: v.number(),
	b: v.number()
});
createServerFunction("add-numbers", async (signal, formData) => {
	await new Promise((res) => setTimeout(res, 331));
	const json = JSON.parse(formData);
	const preparsed = Object.fromEntries(Object.entries(json).map(([key, val]) => [key, normalizeValue(val)]));
	const valid = v.safeParse(AddSchema, preparsed);
	signal?.throwIfAborted();
	if (valid.issues) {
		const { nested } = v.flatten(valid.issues);
		return { error: nested };
	}
	signal?.throwIfAborted();
	return valid.output.a + valid.output.b;
});
createServerFunction("get-server-time", async (signal, locale) => {
	signal?.throwIfAborted();
	await new Promise((res) => setTimeout(res, 500));
	return {
		locale,
		time: (/* @__PURE__ */ new Date()).toLocaleTimeString(locale),
		iso: (/* @__PURE__ */ new Date()).toISOString()
	};
}, { method: "GET" });
//#endregion
//#region src/entry-server.ts
async function render(_url) {
	const { data: greeting } = sayHi("John Doe");
	console.log(`SSR greeting "${await greeting}"`);
	return { html: `
    <div>
      <h1>Hello World!</h1>
      <p class="read-the-docs">
        SSR Example using <code>@thednp/rpc</code> with <code>h3</code>
      </p>
      <form id="addForm">
        <h2>Form</h2>
        <div style="display: flex; align-items: center; gap: 0.5rem">
          <label for="a">A</label>
          <div class="form-input">
            <input id="a" name="a" type="number" placeholder="Value A" />
            <div id="error-a" style="color: red"></div>
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: 10px">
          <label for="b">B</label>
          <div class="form-input">
            <input id="b" name="b" type="text" placeholder="Value B" />
            <div id="error-b" style="color: red"></div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 10px">
          <label for="output">></label>
          <output id="output">Result: 0</output>

          <button type="submit">Add</button>
          <button id="cancelBtn" type="button">Cancel</button>
        </div>
      </form>

      <form id="timeForm">
        <h2>GET</h2>
        <div style="display: flex; align-items: center; gap: 0.5rem">
          <label for="locale">Locale</label>
          <div class="form-input">
            <input id="locale" name="locale" type="text" placeholder="en-US" value="en-US" />
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 10px">
          <label for="time-output">></label>
          <output id="time-output">Time: —</output>
          <button type="submit">Get time</button>
          <a id="time-link" href="#">Open in new tab</a>
        </div>
      </form>
    </div>
  ` };
}
//#endregion
export { render };
