/**
 * App-layer nojs fallback for the demo contact form.
 *
 * Native (nojs) form submissions are `POST`s with
 * `application/x-www-form-urlencoded` and an `Accept: text/html` header.
 * The generated JS client instead sends `multipart/form-data` with fetch's
 * default `Accept` of anything, so those requests never match and continue
 * on to the RPC middleware.
 *
 * On a match this middleware validates the fields with the same shared
 * schema as the server function and PRG-redirects: to the GitHub issue URL
 * on success, or back to `/?name=..&errors=..` on validation failure.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, redirect } from "@thednp/rpc/express";
import {
  buildIssueUrl,
  CONTACT_FIELDS,
  validateContactForm,
} from "./contact-form.ts";

type FormFallbackOptions = {
  rpcPrefix: string;
  functionName: string;
};

type Request = IncomingMessage & { body?: unknown };

type Response = ServerResponse;

const getUrl = (req: Request): URL => new URL(req.url ?? "/", "http://localhost");

const isFormNavigation = (
  req: Request,
  contentType: string,
  accept: string,
  route: string,
): boolean => {
  if (req.method?.toUpperCase() !== "POST") return false;
  if (getUrl(req).pathname !== route) return false;
  // Browser navigations send this; fetch-based RPC calls do not.
  if (!accept.includes("text/html")) return false;
  // Native forms are urlencoded; the JS client posts multipart.
  if (!contentType.includes("urlencoded")) return false;
  return true;
};

/**
 * Creates the demo's form-fallback middleware for a given RPC route.
 * Mounted before the RPC middleware so native form navigations to the
 * contact function get a proper PRG redirect instead of raw JSON.
 */
export const createFormFallback = ({
  rpcPrefix,
  functionName,
}: FormFallbackOptions) => {
  const route = `/${rpcPrefix}/${functionName}`;

  return async (req: Request, res: Response, next?: () => void) => {
    const contentType = (req.headers["content-type"] ?? "").toLowerCase();
    const accept = req.headers.accept ?? "";
    if (!isFormNavigation(req, contentType, accept, route)) {
      return next?.();
    }

    const { data } = await readBody(req);
    const fields = Object.fromEntries(
      Object.entries((data ?? {}) as Record<string, unknown>).filter(
        ([, value]) => typeof value === "string",
      ),
    ) as Record<string, string>;

    const result = validateContactForm(fields);
    if (result.ok) {
      redirect(res, buildIssueUrl(result.output) + "#contact");
      return;
    }

    const search = new URLSearchParams();
    for (const field of CONTACT_FIELDS) {
      const value = fields[field];
      if (value) search.set(field, value);
    }
    search.set("errors", Object.keys(result.errors).join(","));
    redirect(res, `/?${search.toString()}#contact`);
  };
};
