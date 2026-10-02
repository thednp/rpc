// src/fastify/createMiddleware.ts
import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from "fastify";
import type {
  FastifyMiddlewareFn,
  FastifyMiddlewareOptions,
} from "./types.d.ts";
import type { JsonValue } from "@thednp/rpc";
import type { RequestEvent } from "@thednp/rpc/server";
import {
  createDispatcher,
  dispatchRequest,
  tagBodyId,
} from "../execution-log.ts";
import type { ContentType } from "../types.d.ts";
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
  safeURL,
  scanForServerFiles,
} from "@thednp/rpc/server";
import { getFunctionsForPrefix } from "../functionsMap.ts";
import { defaultMiddlewareOptions } from "../options.ts";
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
import { formFallbackLocation, formSuccessLocation } from "../form-fallback.ts";
import { readBody, redirect as fastifyRedirect } from "./helpers.ts";

let middlewareCount = 0;
const middlewareStack = new Set<string>();

/**
 * Creates a Fastify preHandler hook with optional path and rpcPrefix filtering.
 * Middleware names are deduplicated. Prefix and path regexes are compiled once at creation time.
 * @param initialOptions - Options for rpcPrefix, path matching, and the handler function
 * @returns A Fastify preHandler hook function
 */
export const createMiddleware: FastifyMiddlewareFn = (initialOptions = {}) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    initialOptions,
  ) as FastifyMiddlewareOptions;

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
    req: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ) => {
    const reqUrl = safeURL(req.url);
    const url = reqUrl.pathname;

    // No need to continue when no handler provided
    if (!handler) {
      done();
      return;
    }

    // Path matching
    if (pathMatcher && !pathMatcher.test(url)) {
      done();
      return;
    }

    // rpcPrefix matching (boundary-safe via escaped regex)
    if (prefixRegex && !prefixRegex.test(url)) {
      done();
      return;
    }

    // When serving from production server, scan for server files
    if (getFunctionsForPrefix(resolvedPrefix).size === 0) {
      await scanForServerFiles({
        rpcPrefix: resolvedPrefix,
        serverFiles: (options as unknown as { serverFiles?: "exact" | "glob" })
          .serverFiles,
        scanRoot: (options as unknown as { scanRoot?: string }).scanRoot,
      } as never);
    }

    // Execute handler
    await handler(req, reply, done);
  };

  Object.defineProperty(middlewareHandler, "name", {
    value: name,
  });

  return middlewareHandler;
};

/**
 * Creates the Fastify RPC middleware that routes incoming requests to registered server functions.
 * Wraps the generic createMiddleware with the RPC handler that reads the body, dispatches
 * to the matching function, and sends the JSON-serialized result.
 * @param initialOptions - Options including rpcPrefix for URL routing
 * @returns A Fastify preHandler hook function
 */
export const createRPCMiddleware: FastifyMiddlewareFn = (
  initialOptions = {},
) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    initialOptions,
  ) as FastifyMiddlewareOptions;

  // Hoist prefix regex (escaped) and the literal prefix-for-replace out of the
  // per-request handler to avoid regex injection and per-request compilation.
  const rpcPrefix = options.rpcPrefix;
  const prefix = resolveRPCPrefix(rpcPrefix);
  const prefixRegex = new RegExp(`^/${escapeRegExp(prefix)}/`);
  const prefixReplace = `/${prefix}/`;

  // One emitter per middleware, holding no request state.
  const emit = createDispatcher(options.onDispatch);

  return createMiddleware({
    ...options,
    // Hand the resolved prefix down so the gate and the dispatch agree.
    rpcPrefix: prefix,
    handler: async (
      req: FastifyRequest,
      reply: FastifyReply,
      _done: HookHandlerDoneFunction,
    ) =>
      await dispatchRequest<void>({
        emit,
        prefix,
        method: () => req.method,
        readStatus: () => reply.statusCode,
        // fastify writes through `reply.send()`, so by the time a result comes
        // back the body is already gone. The send is wrapped instead, using the
        // id handed over before the body runs.
        onStart: (id) => {
          const send = reply.send.bind(reply);
          reply.send = ((body?: unknown) => {
            const status = reply.statusCode;
            return send(status >= 400 ? tagBodyId(body, id) : body);
          }) as typeof reply.send;
        },
        run: async (seen) => {
          const reqUrl = safeURL(req.url);
          const url = reqUrl.pathname;

          // Defense-in-depth: validate prefix match via escaped regex even though
          // the outer createMiddleware gates on the same prefix already.
          // istanbul ignore if
          if (prefixRegex && !prefixRegex.test(url)) {
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
            reply.status(403).send({ error: REQUEST_FORBIDDEN });
            return;
          }

          const functionName = url.replace(prefixReplace, "");
          const forPrefix = getFunctionsForPrefix(prefix);
          const serverFunction = forPrefix.get(functionName);
          if (emit) {
            seen.functionName = functionName;
            // The sibling names turn "Function not found" into a question an agent
            // can actually answer.
            seen.registered = [...forPrefix.keys()];
            seen.actualContentType = req.headers["content-type"];
          }

          if (!serverFunction) {
            reply.status(404).send({
              error: FUNCTION_NOT_FOUND,
            });
            return;
          }

          // Out here rather than inside the `try` so the `catch` can read the submitted
          // first argument: a no-JS failure redirects, and the flash can only replay
          // what was actually sent.
          let args: JsonValue[] = [];

          try {
            const method = serverFunction.options?.method || "POST";
            if (emit) {
              seen.declaredMethod = method;
              seen.declaredContentType = serverFunction.options?.contentType ??
                "application/json";
              seen.contentTypeMatched = !hasContentTypeMismatch(
                seen.declaredContentType as ContentType,
                req.headers["content-type"],
              );
            }
            if (req.method.toUpperCase() !== method) {
              reply.status(405).send({ error: METHOD_NOT_ALLOWED });
              return;
            }

            if (method === "GET") {
              const raw = reqUrl.searchParams.get("args");
              if (raw) {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(raw);
                } catch {
                  // A malformed `?args=` is a malformed request, not a server
                  // fault, so it answers 400 like the non-array case above.
                  reply.status(400).send({ error: BAD_REQUEST });
                  return;
                }
                if (!Array.isArray(parsed)) {
                  reply.status(400).send({ error: BAD_REQUEST });
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
                reply.status(415).send({ error: UNSUPPORTED_MEDIA_TYPE });
                return;
              }
              const body = await readBody(req, options.bodyLimit);
              args = Array.isArray(body.data)
                ? body.data as JsonValue[]
                : [body.data as JsonValue];
            }
            const requestEvent: RequestEvent = {
              request: req,
              response: reply,
              nativeEvent: req,
              locals: {},
              functionName,
              redirect: (location, status = 303) => {
                requestEvent.redirected = { location, status };
                fastifyRedirect(reply, location, status);
              },
              send: (status, body, headers) => {
                requestEvent.sent = { status, body, headers };
                if (headers) {
                  for (const [name, value] of Object.entries(headers)) {
                    reply.header(name, value);
                  }
                }
                reply.status(status).send(body);
              },
              header: (name, value) => {
                // `sent` covers hijacked and already-ended replies; a header
                // staged after the flush would be dropped silently anyway.
                if (reply.sent) return;
                reply.header(name, value);
              },
            };
            // Input validation, before the handler is entered. The schema describes
            // this function's input — its first argument after the AbortSignal — and
            // a rejected input is a `422`, not a server fault. The validated output
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

            const { data: dataResult, cancel } = provideRequestContext(
              requestEvent,
              // Raw arguments, recorded before validation: a rejected input is the
              // case where the shape matters most, and it is the pre-transform shape
              // that answers "what did the client send".
              () => {
                if (emit) seen.args = args;
                return serverFunction.handler(...args);
              },
            );
            const onClose = () => cancel(CLIENT_DISCONNECTED);

            req.raw.on("close", onClose);
            const data = await dataResult;
            req.raw.off("close", onClose);

            // The no-JS success path, before the JSON send for the same ordering
            // reason as the `catch` — and only for a navigation, so a `fetch`
            // from the generated stub still gets its JSON.
            const successFlash = formSuccessLocation(
              serverFunction.options?.fallback,
              args[0],
              {
                method: req.method,
                contentType: req.headers["content-type"] as string | undefined,
                accept: req.headers["accept"] as string | undefined,
                secFetchDest: req.headers["sec-fetch-dest"] as
                  | string
                  | undefined,
                secFetchMode: req.headers["sec-fetch-mode"] as
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
              fastifyRedirect(reply, successFlash);
              return;
            }

            // istanbul ignore else
            if (
              !requestEvent.redirected &&
              !requestEvent.sent &&
              !reply.raw.headersSent
            ) {
              reply.status(200).send({ data });
            }
          } catch (err) {
            // A malformed request is a client error, not a server fault. rpc raises
            // these with a status (see `httpError`), and host frameworks signal the
            // same class the same way — h3's body limit throws 413 from inside the
            // read, Express's body-parser throws 400, and Fastify's parser does the
            // same before rpc is reached. Answering 500 for any of them both
            // misreports the fault and turns a trivial client mistake into a log
            // entry. The body comes from a fixed table, so nothing from the
            // underlying error is echoed back.
            // Reported here rather than by the wrapper: this adapter catches the
            // throw itself and answers through `reply`, so nothing escapes `run`.
            // The no-JS flow goes **first**, ahead of the client-error branch
            // below: a `ValidationError` is itself client-facing, so that branch
            // would claim it and render a `422` JSON body, leaving the only user
            // this feature exists for staring at raw JSON.
            const flash = formFallbackLocation(
              err,
              serverFunction.options?.fallback,
              args[0],
              {
                method: req.method,
                contentType: req.headers["content-type"] as string | undefined,
                accept: req.headers["accept"] as string | undefined,
                secFetchDest: req.headers["sec-fetch-dest"] as
                  | string
                  | undefined,
                secFetchMode: req.headers["sec-fetch-mode"] as
                  | string
                  | undefined,
              },
            );
            if (flash !== undefined) {
              seen.status = 303;
              fastifyRedirect(reply, flash);
              return;
            }
            seen.error = err;
            const isProduction = process.env.NODE_ENV === "production";
            if (isClientHttpError(err)) {
              const status = clientErrorStatus(err);
              reply.status(status).send(formatError(err, isProduction));
              return;
            }
            console.error(String(err));
            reply.status(500).send(formatError(err, isProduction));
          }
        },
      }),
  });
};
