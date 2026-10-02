import {
  createServerFunction,
  getRequestContext,
  getRequestMeta,
  isNativeFormNavigation,
} from "@thednp/rpc/server";
import pkg from "../../package.json" with { type: "json" };
import rootPkg from "../../../package.json" with { type: "json" };
import cfg from "../../rpc.config.ts";

import {
  buildIssueUrl,
  ContactSchema,
  type ContactOutput,
} from "../lib/contact-form";

// Serverless requires explicit handling
import { setGlobalPrefix } from "@thednp/rpc/server";
setGlobalPrefix(cfg.rpcPrefix);

export const sayHi = createServerFunction(
  "say-hi",
  async (signal, name: string) => {
    signal?.throwIfAborted();
    await new Promise((res) => setTimeout(res, 400));
    signal?.throwIfAborted();
    return `Hello ${name}! This reply came from a server function.`;
  },
  { contentType: "text/plain" },
);

export const getServerTime = createServerFunction(
  "get-server-time",
  async (signal, locale: string) => {
    signal?.throwIfAborted();
    return {
      locale,
      time: new Date().toLocaleTimeString(locale),
      date: new Date().toLocaleDateString(locale, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
      iso: new Date().toISOString(),
    };
  },
  { method: "GET" },
);

export const getLibraryInfo = createServerFunction(
  "get-library-info",
  async () => {
    let version = pkg.dependencies["@thednp/rpc"] || rootPkg.version;
    const tagline = rootPkg.description;
    if (version.startsWith("link:") || version.startsWith("file:")) {
      version = rootPkg.version;
    } else if (version.startsWith("^") || version.startsWith("~")) {
      version = version.slice(1);
    }
    return {
      name: "@thednp/rpc",
      version,
      tagline,
      adapters: ["express", "fastify", "hono", "koa", "h3"],
      prefix: "/@demo",
    };
  },
  { method: "GET" },
);

type ContactErrors = Partial<Record<string, [string, ...string[]]>>;

type GitHubUser = {
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
  bio: string | null;
};

type ContactResult =
  | { status: "error"; errors: ContactErrors }
  | {
      status: "ok";
      receivedAt: string;
      ticket: string;
      githubUser: GitHubUser | null;
    };

const fetchGitHubUserByEmail = async (
  email: string,
  signal: AbortSignal,
): Promise<GitHubUser | null> => {
  try {
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "@thednp/rpc",
    };
    const searchUrl = `https://api.github.com/search/users?q=${encodeURIComponent(email)}+in:email&per_page=1`;
    const searchRes = await fetch(searchUrl, { headers, signal });
    if (!searchRes.ok) return null;
    const searchData = (await searchRes.json()) as {
      items?: Array<{ login: string; avatar_url: string; html_url: string }>;
    };
    const item = searchData.items?.[0];
    if (!item) return null;

    const profileRes = await fetch(`https://api.github.com/users/${item.login}`, { headers, signal });
    if (!profileRes.ok) return null;
    const profile = (await profileRes.json()) as { name?: string | null; bio?: string | null };

    return {
      login: item.login,
      name: profile.name ?? null,
      avatar_url: item.avatar_url,
      html_url: item.html_url,
      bio: profile.bio ?? null,
    };
  } catch {
    return null;
  }
};

/**
 * Issues a redirect when this call is a *native form navigation*, and does
 * nothing otherwise.
 *
 * Two cases fall through to no redirect:
 * - `getRequestContext()` throws outside a dispatch — per-request data does not
 *   exist in a direct call, and `submitContact` is called directly by SSR and by
 *   tests. The absence of a context is normal here rather than an error.
 * - The call came from the generated stub (`Sec-Fetch-Mode: cors`). A `303` there
 *   would make the browser's `fetch` *follow* the redirect off-origin to GitHub,
 *   which has no `Access-Control-Allow-Origin` for us — the console CORS error on
 *   the deployed demo. The JSON `{ data }` result is what the stub wants anyway:
 *   the page opens the issue URL itself. Only the no-JS `<form>` wants the
 *   `303`, so only the navigation gets one.
 */
const redirectTo = (location: string) => {
  let event;
  try {
    event = getRequestContext();
  } catch {
    // No request context: the caller wanted the result, not a redirect.
    return;
  }
  const meta = getRequestMeta(event);
  const header = (name: string) => {
    const value = meta.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const navigation = isNativeFormNavigation({
    method: meta.method,
    contentType: header("content-type"),
    accept: header("accept"),
    secFetchDest: header("sec-fetch-dest"),
    secFetchMode: header("sec-fetch-mode"),
  });
  if (navigation) event.redirect(location);
};

export const submitContact = createServerFunction(
  "submit-contact",
  // The validated output, not the raw body: `schema` transforms before the handler
  // is entered, so `payload` is already trimmed and typed. That is the point of
  // validating at the boundary rather than inside the function.
  async (signal, payload: ContactOutput): Promise<ContactResult> => {
    await new Promise((res) => setTimeout(res, 600));
    signal?.throwIfAborted();
    const githubUser = await fetchGitHubUserByEmail(payload.email, signal);

    // The success redirect is the *handler's*, not the fallback's: the target is
    // off-origin, and `fallback.to` is deliberately restricted to root-relative
    // paths so an author cannot turn it into an open redirect. This is also the
    // documented precedence — a handler redirect wins over the fallback. And the
    // redirect only happens for native navigations; `redirectTo` decides that.
    redirectTo(buildIssueUrl({ ...payload, ghLogin: githubUser ? `@${githubUser.login}` : "" }) + "#contact");

    return {
      status: "ok",
      receivedAt: new Date().toISOString(),
      ticket: `RPC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      githubUser,
    } as ContactResult;
  },
  {
    // urlencoded for *both* clients now, which is what makes the no-JS
    // fallback's discriminator non-obvious: the generated stub and a native
    // `<form>` send the same encoding, so only `Accept` / `Sec-Fetch-*` can tell
    // a navigation from an RPC call.
    contentType: "application/x-www-form-urlencoded",
    schema: ContactSchema,
    fallback: {
      // Where a *failed* submission lands: back on the demo page, which reads the
      // flash out of `__flash`. Root-relative on purpose — see the handler above.
      to: "/",
      // Replay only what is safe in a URL: a title and a message body are not,
      // so they are dropped and the user retypes those two.
      replay: ["name", "email", "topic"],
    },
  },
);
