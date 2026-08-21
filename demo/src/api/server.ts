import { createServerFunction } from "@thednp/rpc/server";
import pkg from "../../package.json" with { type: "json" };
import rootPkg from "../../../package.json" with { type: "json" };

import {
  CONTACT_FIELDS,
  parseMultipartFormData,
  validateContactForm,
} from "../lib/contact-form";

// Serverless requires explicit handling
import { setGlobalPrefix } from "@thednp/rpc/server";
import cfg from "../../rpc.config.ts";
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
      "User-Agent": "@thednp/rpc-demo",
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

export const submitContact = createServerFunction(
  "submit-contact",
  async (signal, payload: FormData): Promise<ContactResult> => {
    await new Promise((res) => setTimeout(res, 600));
    const candidate = payload as FormData & {
      raw?: string;
      name?: string;
    };
    // Multipart (JS client) carries { raw }; urlencoded (curl/nojs direct
    // posts) carries the fields as a plain object. Normalize to flat fields.
    const fieldsSource = candidate.raw
      ? parseMultipartFormData(candidate.raw)
      : (payload as unknown as Record<string, unknown>);
    const parsed = Object.fromEntries(
      CONTACT_FIELDS.map((field) => [
        field,
        String(fieldsSource[field] ?? ""),
      ]),
    );
    const valid = validateContactForm(parsed);
    signal?.throwIfAborted();
    if (!valid.ok) {
      return { status: "error", errors: valid.errors } as ContactResult;
    }
    signal?.throwIfAborted();

    const githubUser = await fetchGitHubUserByEmail(valid.output.email, signal);

    return {
      status: "ok",
      receivedAt: new Date().toISOString(),
      ticket: `RPC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      githubUser,
    } as ContactResult;
  },
  { contentType: "multipart/form-data" },
);
