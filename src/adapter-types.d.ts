/** @module Adapter-agnostic normalized request/response shapes. Shared by every adapter so a wrapper can write one helper against all five frameworks. Type-only — erased at build. */
import type { IncomingHttpHeaders } from "node:http";
import type { JsonValue } from "./types.d.ts";

/**
 * Wraps a server response to normalize status, header, and send operations
 * across Node `ServerResponse` and framework response objects.
 *
 * Re-exported from every adapter (`@thednp/rpc/express`, `/fastify`, `/hono`,
 * `/koa`, `/h3`) so a consumer can name the shape without importing from the
 * express adapter specifically.
 */
export type ResponseDetails = {
  /** Whether the response was already sent */
  isResponseSent: boolean;
  /** Sets a response header */
  setHeader: (name: string, value: string) => void;
  /** Current response status code */
  statusCode: number;
  /** Sets the response status code */
  setStatusCode: (code: number) => void;
  /** Sends a JSON response with the given status code and output */
  sendResponse: (code: number, output: JsonValue) => void;
};

/**
 * Normalized view of an incoming request: URL parts, headers, and method.
 *
 * Re-exported from every adapter, for the same reason as {@link ResponseDetails}.
 */
export type RequestDetails = {
  /** Full request URL (path + query string) */
  url: string;
  /** Query string including the leading `?` */
  search: string;
  /** Parsed query string parameters */
  searchParams: URLSearchParams;
  /** Raw request headers */
  headers: IncomingHttpHeaders;
  /** HTTP method (GET, POST, etc.) */
  method: string | undefined;
};
