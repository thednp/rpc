// src/express/createMidleware.ts
import { formFallbackLocation, formSuccessLocation } from "../form-fallback.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  NextFunction,
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";
import type {
  ExpressMiddlewareFn,
  ExpressMiddlewareOptions,
} from "./types.d.ts";
import type { Connect } from "vite";
import type { ContentType, JsonObject } from "../types.d.ts";
import type { JsonValue } from "../types.d.ts";
import type { RequestEvent } from "@thednp/rpc/server";
import {
  clientErrorStatus,
  describeOriginRequest,
  escapeRegExp,
  formatError,
  hasContentTypeMismatch,
  isClientHttpError,
  provideRequestContext,
  resolveRPCPrefix,
  runValidation,
  scanForServerFiles,
} from "@thednp/rpc/server";
import type { OriginTier } from "../server-helpers.ts";
import { createDispatcher, newDispatchId } from "../execution-log.ts";
import { getFunctionsForPrefix } from "../functionsMap.ts";
import { defaultMiddlewareOptions } from "../options.ts";
import {
  getRequestDetails,
  getResponseDetails,
  readBody,
  redirect as expressRedirect,
} from "./helpers.ts";
import {
  BAD_REQUEST,
  CLIENT_DISCONNECTED,
  FUNCTION_NOT_FOUND,
  METHOD_NOT_ALLOWED,
  MIDDLEWARE_NAME_USED,
  REQUEST_FORBIDDEN,
  UNSUPPORTED_MEDIA_TYPE,
  VALIDATION_HINT,
} from "../constants.ts";

let middlewareCount = 0;
const middlewareStack = new Set<string>();

/**
 * Creates an Express middleware with optional path and rpcPrefix filtering.
 * Middleware names are deduplicated — reusing a name throws an error.
 * Prefix and path regexes are compiled once at creation time (hoisted) for performance.
 * @param initialOptions - Options for rpcPrefix, path matching, and the handler function
 * @returns An Express middleware function
 */
export const createMiddleware: ExpressMiddlewareFn = (initialOptions = {}) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    initialOptions,
  ) as ExpressMiddlewareOptions;
  const middlewareName = options.name;
  const rpcPrefix = options.rpcPrefix;
  const path = options.path;
  const handler = options.handler;

  let name = middlewareName;
  if (!name) {
    name = "viteRPCMiddleware-" + middlewareCount;
    middlewareCount += 1;
  }
  if (middlewareStack.has(name)) {
    throw new Error(MIDDLEWARE_NAME_USED(name));
  }
  middlewareStack.add(name);

  // Hoist regex compilation out of per-request path. Escape the prefix to
  // prevent regex injection via metacharacters in the config string.
  // Resolved once at creation time so the hoisted regex and the
  // function-map lookup can never disagree. `createRPCMiddleware` hands
  // over its already-resolved prefix, making this a no-op in that path.
  const resolvedPrefix = resolveRPCPrefix(rpcPrefix);
  // Gated only when an explicit prefix was supplied: a bare
  // `createMiddleware({ path, handler })` has never prefix-gated.
  // `createRPCMiddleware` always supplies one, so RPC dispatch does.
  const prefixRegex: RegExp | null = rpcPrefix
    ? new RegExp(`^/${escapeRegExp(resolvedPrefix)}/`)
    : null;
  const pathMatcher: RegExp | null = path
    ? (typeof path === "string" ? new RegExp(path) : path)
    : null;

  const middlewareHandler = async (
    req: IncomingMessage | ExpressRequest,
    res: ServerResponse | ExpressResponse,
    next: Connect.NextFunction | NextFunction,
  ) => {
    const { url } = getRequestDetails(req);

    // No need to continue when no handler provided
    if (!handler) {
      return next?.();
    }

    // Path matching
    if (pathMatcher && !pathMatcher.test(url)) return next?.();

    // rpcPrefix matching (boundary-safe via escaped regex)
    if (prefixRegex && !prefixRegex.test(url)) {
      return next?.();
    }

    // When serving from production server, scan for server files
    if (getFunctionsForPrefix(resolvedPrefix).size === 0) {
      await scanForServerFiles({
        rpcPrefix: resolvedPrefix,
        serverFiles: options.serverFiles,
        scanRoot: options.scanRoot,
      } as never);
    }

    // Execute handler
    await handler(req, res, next);
  };

  Object.defineProperty(middlewareHandler, "name", {
    value: name,
  });

  return middlewareHandler;
};

/**
 * Creates the Express RPC middleware that routes incoming requests to registered server functions.
 * Reads the request body, dispatches to the matching function via getFunctionsForPrefix,
 * and sends the JSON-serialized result. Handles client disconnection via abort signals.
 * Supports multi-prefix setups where different middleware instances can route to functions
 * registered under different prefixes.
 * @param initialOptions - Options including rpcPrefix for URL routing and prefix-scoped function lookup
 * @returns An Express middleware function
 */
export const createRPCMiddleware: ExpressMiddlewareFn = (
  initialOptions = {},
) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    initialOptions,
  ) as ExpressMiddlewareOptions;

  // Hoist prefix regex (escaped) and the literal prefix-for-replace out of the
  // per-request handler to avoid regex injection and per-request compilation.
  const rpcPrefix = options.rpcPrefix;
  const prefix = resolveRPCPrefix(rpcPrefix);

  const prefixRegex = new RegExp(`^/${escapeRegExp(prefix)}/`);
  const prefixReplace = `/${prefix}/`;

  // One dispatcher per middleware, not per request: it holds no request state.
  // `undefined` when no hook is registered, and the adapter then skips every
  // line below — which is also why the correlation id appears on a failure
  // response only when somebody is collecting.
  const dispatch = createDispatcher(options.onDispatch);

  return createMiddleware({
    ...options,
    // Hand the resolved prefix down so the gate and the dispatch agree.
    rpcPrefix: prefix,
    handler: async (
      req: IncomingMessage | ExpressRequest,
      res: ServerResponse | ExpressResponse,
      _next: NextFunction | Connect.NextFunction,
    ) => {
      const { url: path, searchParams } = getRequestDetails(req);
      const { sendResponse: rawSend } = getResponseDetails(res);

      // Everything observed during the dispatch, for the `onDispatch` record.
      // Declared before `sendResponse` is wrapped so the wrapper can record the
      // status without the rest of the handler having to.
      const startedAt = Date.now();
      const callId = dispatch ? newDispatchId() : undefined;
      const seen: {
        status: number;
        error?: unknown;
        functionName?: string;
        registered?: readonly string[];
        declaredMethod?: string;
        declaredContentType?: string;
        contentTypeMatched?: boolean;
        actualContentType?: ContentType;
        args?: readonly unknown[];
        originTier: OriginTier;
      } = { status: 200, originTier: "headerless" };

      // Every exit path goes through `sendResponse`, so wrapping it observes
      // all of them at once — the 403, the 404, the 405, the 415 and the throw
      // below included. An emit at each `return` would be five sites to keep in
      // step, and the first one someone forgets is the bug.
      // One recorder, called from the `finally` below and from the two returns
      // that happen before the `try` opens. Those two are the origin rejection
      // and the function-not-found, which are exactly the dispatches a record
      // matters most for — a `finally` alone would silently skip both.
      const record = () => {
        dispatch?.({
          id: callId,
          prefix,
          originTier: seen.originTier,
          // A Node IncomingMessage always carries a method, so the `?? ""` is a
          // type guard rather than a runtime path — but it is still exercised
          // in the tests, because an uncovered defensive branch is one nobody
          // has read.
          method: req.method ?? "",
          functionName: seen.functionName,
          registeredNames: seen.registered,
          declaredMethod: seen.declaredMethod,
          declaredContentType: seen.declaredContentType,
          actualContentType: seen.actualContentType,
          contentTypeMatched: seen.contentTypeMatched,
          args: seen.args,
          status: seen.status,
          error: seen.error,
          startedAt,
        });
      };

      const sendResponse = (status: number, body?: JsonObject) => {
        seen.status = status;
        // The id goes on failures only, and only when a hook is registered:
        // with nobody collecting it, a new field in the error body would be a
        // change to the wire contract for nobody's benefit.
        rawSend(
          status,
          callId !== undefined && status >= 400
            ? { ...body, id: callId }
            : body,
        );
      };

      // Validate the url starts with the prefix via the escaped regex
      // istanbul ignore next
      if (prefixRegex && !prefixRegex.test(path)) {
        // falls through to next handler (never reached in practice; the outer
        // createMiddleware already gates on this, but kept for defense-in-depth)
        return;
      }

      // Cross-origin check, on by default (`origin: "self"`). `Origin` decides
      // when present; `Sec-Fetch-Site` is the fail-closed fallback once it is
      // gone; headerless clients are opt-in via `allowHeaderless`. The Host
      // header is used only for the host-only "self" comparison — no forwarded
      // header is trusted. See `isOriginRequestAllowed` for the three tiers.
      const origin = describeOriginRequest({
        allowed: options.origin,
        origin: req.headers.origin,
        site: req.headers["sec-fetch-site"],
        host: req.headers.host,
        allowHeaderless: options.allowHeaderless,
      });
      seen.originTier = origin.tier;
      if (!origin.allowed) {
        sendResponse(403, { error: REQUEST_FORBIDDEN });
        record();
        return;
      }

      const functionName = path.replace(prefixReplace, "");
      // Look up function in the prefix-scoped map
      const serverFunctionsForPrefix = getFunctionsForPrefix(prefix);
      const serverFunction = serverFunctionsForPrefix.get(functionName);
      if (dispatch) {
        seen.functionName = functionName;
        // The sibling names are what turns "Function not found" into "did you
        // mean", which is the question an agent actually has.
        seen.registered = [...serverFunctionsForPrefix.keys()];
      }

      if (!serverFunction) {
        sendResponse(404, { error: FUNCTION_NOT_FOUND });
        record();
        return;
      }

      // Declared out here rather than inside the `try` so the `catch` can read the
      // submitted first argument: a no-JS failure redirects, and the flash can
      // only replay what was actually sent.
      let args: JsonValue[] = [];

      try {
        const method = serverFunction.options?.method || "POST";
        if (dispatch) {
          seen.declaredMethod = method;
          seen.declaredContentType = serverFunction.options?.contentType ??
            "application/json";
          seen.actualContentType = req.headers["content-type"] as
            | ContentType
            | undefined;
          seen.contentTypeMatched = !hasContentTypeMismatch(
            seen.declaredContentType as ContentType,
            req.headers["content-type"],
          );
        }
        if (req.method?.toUpperCase() !== method) {
          sendResponse(405, { error: METHOD_NOT_ALLOWED });
          return;
        }

        if (method === "GET") {
          const raw = searchParams.get("args");
          if (raw) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              // A malformed `?args=` is a malformed request, not a server
              // fault. Express-style hosts answer 400 for the equivalent
              // malformed-body case, so match them.
              sendResponse(400, { error: BAD_REQUEST });
              return;
            }
            if (!Array.isArray(parsed)) {
              sendResponse(400, { error: BAD_REQUEST });
              return;
            }
            args = parsed as JsonValue[];
          }
        } else {
          // Content-type enforcement: strict for json/text, lenient between forms.
          // Requests without a Content-Type header are exempt (curl/GET compat).
          // Checked BEFORE readBody so mismatched bodies are never buffered.
          if (
            hasContentTypeMismatch(
              serverFunction.options?.contentType ?? "application/json",
              req.headers["content-type"],
            )
          ) {
            sendResponse(415, { error: UNSUPPORTED_MEDIA_TYPE });
            return;
          }
          const body = await readBody(req, options.bodyLimit);
          args = Array.isArray(body.data)
            ? (body.data as JsonValue[])
            : [body.data as JsonValue];
        }
        // Recorded *before* validation, and deliberately the raw arguments: a
        // rejected input is the case where the shape is most worth having, and
        // the raw shape is the one that answers "what did the client actually
        // send" — which the post-transform shape would have normalised away.
        if (dispatch) seen.args = args;
        // Input validation, before the handler is entered. The schema describes
        // this function's input — its first argument after the AbortSignal — and
        // a rejected input is a `422`, not a server fault. Validated output
        // replaces the raw argument, so the type flows from the schema into the
        // handler without a cast.
        const schema = serverFunction.options?.schema;
        if (schema) {
          const checked = await runValidation(schema, args[0], {
            hints: serverFunction.options?.hints,
            // A per-function hint leads, then rpc's own pointer to the docs,
            // so one function-wide `hint` does not cost the documentation link.
            hint: serverFunction.options?.hint
              ? `${serverFunction.options.hint} — ${VALIDATION_HINT}`
              : VALIDATION_HINT,
          });
          if (!checked.ok) throw checked.error;
          args = [checked.value as JsonValue, ...args.slice(1)];
        }

        // ─── Dispatch ────────────────────────────────────────────────────
        // Establish the per-request context around the *entire* dispatch so
        // server functions (and async continuations spawned by their work)
        // read `getRequestContext()` and can call the framework-level
        // `redirect(location)`. The adapter-specific redirect is bound into the
        // context here; `serverFunction.handler` must be invoked inside the
        // context callback so its async increments run with the context live.
        const requestEvent: RequestEvent = {
          request: req,
          response: res,
          nativeEvent: { req, res },
          locals: (res as ExpressResponse).locals ?? {},
          functionName,
          redirect: (location, status = 303) => {
            requestEvent.redirected = { location, status };
            expressRedirect(res, location, status);
          },
          send: (status, body, headers) => {
            requestEvent.sent = { status, body, headers };
            const details = getResponseDetails(res);
            if (headers) {
              for (const [name, value] of Object.entries(headers)) {
                details.setHeader(name, value);
              }
            }
            details.sendResponse(status, body);
          },
        };

        const { data, cancel } = provideRequestContext(
          requestEvent,
          () => serverFunction.handler(...args),
        );
        const onClose = () => cancel(CLIENT_DISCONNECTED);
        req.on("close", onClose);
        const result = await data;
        req.off("close", onClose);

        // The no-JS success path: redirect before the JSON send, for the same
        // ordering reason as the `catch` — but only for a navigation, so a
        // `fetch` from the generated stub still gets its JSON.
        const successDetails = getRequestDetails(req);
        const successFlash = formSuccessLocation(
          serverFunction.options?.fallback,
          args[0],
          {
            method: successDetails.method,
            contentType: successDetails.headers["content-type"] as
              | string
              | undefined,
            accept: successDetails.headers["accept"] as string | undefined,
            secFetchDest: successDetails.headers["sec-fetch-dest"] as
              | string
              | undefined,
            secFetchMode: successDetails.headers["sec-fetch-mode"] as
              | string
              | undefined,
          },
        );
        // A handler may have issued its own redirect through the request
        // context. That is a more specific answer than the fallback's, so it
        // wins — otherwise a handler redirect would be silently replaced by
        // the author's fallback target.
        if (successFlash !== undefined && !requestEvent.redirected) {
          requestEvent.redirected = { location: successFlash, status: 303 };
          expressRedirect(res, successFlash);
          return;
        }

        // Skip the JSON send when the server function issued a redirect or
        // short-circuited with `send`; the bound adapter already wrote the
        // response. Express may also have ended the response via headersSent.
        // istanbul ignore else
        if (
          !requestEvent.redirected &&
          !requestEvent.sent &&
          !res.headersSent
        ) {
          sendResponse(200, { data: result });
        }
      } catch (err) {
        // The no-JS flow goes **first**, ahead of the client-error branch below.
        // A `ValidationError` is itself client-facing, so that branch would claim
        // it and render a `422` JSON body — leaving the no-JS user, who is the
        // only reason this exists, staring at raw JSON. Ordering is the whole
        // design here; it is not a stylistic choice.
        const details = getRequestDetails(req);
        const flash = formFallbackLocation(
          err,
          serverFunction.options?.fallback,
          args[0],
          {
            method: details.method,
            contentType: details.headers["content-type"] as string | undefined,
            accept: details.headers["accept"] as string | undefined,
            secFetchDest: details.headers["sec-fetch-dest"] as
              | string
              | undefined,
            secFetchMode: details.headers["sec-fetch-mode"] as
              | string
              | undefined,
          },
        );
        if (flash !== undefined) {
          seen.status = 303;
          expressRedirect(res, flash);
          return;
        }
        // A malformed request is a client error, not a server fault. rpc raises
        // these with a status (see `httpError`), and host frameworks signal the
        // same class the same way — h3's body limit throws 413 from inside the
        // read, Express's body-parser throws 400, and Fastify's parser does the
        // same before rpc is reached. Answering 500 for any of them both
        // misreports the fault and turns a trivial client mistake into a log
        // entry. The body comes from a fixed table, so nothing from the
        // underlying error is echoed back.
        const isProduction = process.env.NODE_ENV === "production";
        seen.error = err;
        if (isClientHttpError(err)) {
          const status = clientErrorStatus(err);
          sendResponse(status, formatError(err, isProduction));
          return;
        }
        console.error(String(err));
        sendResponse(500, formatError(err, isProduction));
      } finally {
        // `finally`, not a trailing statement: the 403/404/405/415 returns above
        // all bypass it, and those are exactly the dispatches a record is most
        // useful for. Nothing is retained — the hook owns the storage.
        record();
      }
    },
  });
};
