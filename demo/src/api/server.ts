import { createServerFunction } from "@thednp/rpc/server";
import pkg from "../../package.json" with { type: "json" };
import rootPkg from "../../../package.json" with { type: "json" };
import * as v from "valibot";

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
    if (version.startsWith("link:") || version.startsWith("file:")) {
      version = rootPkg.version;
    } else if (version.startsWith("^") || version.startsWith("~")) {
      version = version.slice(1);
    }
    return {
      name: "@thednp/rpc",
      version,
      tagline: "Server functions for Vite — without the boilerplate.",
      adapters: ["express", "fastify", "hono", "koa"],
      prefix: "/@demo",
    };
  },
  { method: "GET" },
);

const ContactSchema = v.object({
  name: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(2, "Please tell us your name."),
    v.maxLength(60, "Keep it under 60 characters."),
  ),
  email: v.pipe(
    v.string(),
    v.trim(),
    v.email("That email doesn't look right."),
  ),
  topic: v.pipe(
    v.optional(v.string(), ""),
    v.trim(),
    v.minLength(1, "Pick a topic."),
  ),
  title: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, "Please add a title."),
  ),
  message: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(10, "Give us a bit more detail (10+ characters)."),
    v.maxLength(2000, "Keep it under 2000 characters."),
  ),
});

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

const parseMultipartFormData = (raw: string): Record<string, string> => {
  const boundary = raw.match(/^--([^\r\n]+)/)?.[1];
  if (!boundary) return {};
  const result: Record<string, string> = {};
  for (const part of raw.split(`--${boundary}`).slice(1)) {
    const trimmed = part.replace(/^--/, "").replace(/^\r?\n/, "");
    const separator = trimmed.indexOf("\r\n\r\n");
    if (separator === -1) continue;
    const headers = trimmed.slice(0, separator);
    const nameMatch = headers.match(/name="([^"]+)"/);
    if (!nameMatch || headers.includes("filename=")) continue;
    result[nameMatch[1]] = trimmed.slice(separator + 4).replace(/\r?\n$/, "");
  }
  return result;
};

export const submitContact = createServerFunction(
  "submit-contact",
  async (signal, payload: FormData): Promise<ContactResult> => {
    await new Promise((res) => setTimeout(res, 600));
    const raw = (payload as FormData & { raw: string }).raw;
    const parsed = parseMultipartFormData(raw);
    const valid = v.safeParse(ContactSchema, parsed);
    signal?.throwIfAborted();
    if (valid.issues) {
      return { status: "error", errors: v.flatten(valid.issues).nested ?? {} };
    }
    signal?.throwIfAborted();

    const githubUser = await fetchGitHubUserByEmail(parsed.email, signal);

    return {
      status: "ok",
      receivedAt: new Date().toISOString(),
      ticket: `RPC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      githubUser,
    } as ContactResult;
  },
  { contentType: "multipart/form-data" },
);
