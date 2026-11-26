import type { LogLevel } from "./log.ts";

export interface Config {
  host: string;
  port: number;
  logLevel: LogLevel;
  /** A running firecrawl-local. Without one, a child process is started. */
  localUrl?: string;
  localToken?: string;
  localPath?: string;
  chromePath?: string;
  browser?: "auto" | "never" | "always";
  allowPrivate: boolean;
  /** A running SearXNG. Without one, a child process is started. */
  searxngUrl?: string;
  searxngPath?: string;
  /** The here-docs CLI `/v2/parse` runs. Default: `here-docs` on PATH. */
  parsePath?: string;
  /** How long a document conversion gets. Default: 120 s. */
  parseTimeoutMs?: number;
  /** How long a child gets to start, and the default per-request timeout. */
  timeoutMs: number;
  /** Provider names from `SEX_SEARCH_PROVIDER`, in order; empty means SearXNG only. */
  searchChain: string[];
  /** Names `!name` tokens removed from the chain; `!searxng` turns off the appended fallback. */
  searchExcluded: string[];
  /** API keys per provider, from `SEX_SEARCH_<ID>_KEY`. */
  searchKeys: Record<string, string>;
  /** One provider search's budget; falls back to `timeoutMs`. */
  searchTimeoutMs?: number;
}

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const BROWSERS = ["auto", "never", "always"] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const selection = parseSelection(env.SEX_SEARCH_PROVIDER);
  return {
    host: text(env.SEX_HOST) ?? "127.0.0.1",
    port: integer(env.SEX_PORT, 3002, "SEX_PORT"),
    logLevel: choice(env.SEX_LOG_LEVEL, LEVELS, "info", "SEX_LOG_LEVEL") ?? "info",
    localUrl: text(env.SEX_LOCAL_URL),
    localToken: text(env.SEX_LOCAL_TOKEN),
    localPath: text(env.SEX_LOCAL_PATH),
    chromePath: text(env.SEX_CHROME_PATH),
    browser: choice(env.SEX_BROWSER, BROWSERS, undefined, "SEX_BROWSER"),
    allowPrivate: flag(env.SEX_ALLOW_PRIVATE),
    searxngUrl: text(env.SEX_SEARXNG_URL),
    searxngPath: text(env.SEX_SEARXNG_PATH),
    parsePath: text(env.SEX_PARSE_PATH),
    parseTimeoutMs: integer(env.SEX_PARSE_TIMEOUT, 120_000, "SEX_PARSE_TIMEOUT"),
    timeoutMs: integer(env.SEX_TIMEOUT, 30_000, "SEX_TIMEOUT"),
    searchChain: selection.chain,
    searchExcluded: selection.excluded,
    searchKeys: parseKeys(env),
    searchTimeoutMs: text(env.SEX_SEARCH_TIMEOUT)
      ? integer(env.SEX_SEARCH_TIMEOUT, 30_000, "SEX_SEARCH_TIMEOUT")
      : undefined,
  };
}

/** `SEX_SEARCH_PROVIDER=tavily,brave,!searxng`: an ordered chain plus the names to drop from it. */
function parseSelection(value: string | undefined): { chain: string[]; excluded: string[] } {
  const raw = text(value);
  if (!raw) return { chain: [], excluded: [] };
  const chain: string[] = [];
  const excluded: string[] = [];
  for (const token of raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)) {
    if (!token.startsWith("!")) {
      if (!chain.includes(token)) chain.push(token);
      continue;
    }
    const name = token.slice(1).trim();
    if (!name) throw new Error("SEX_SEARCH_PROVIDER: `!` needs a provider name");
    if (!excluded.includes(name)) excluded.push(name);
  }
  return { chain, excluded };
}

/** Every `SEX_SEARCH_<ID>_KEY`, keyed by the lower-cased provider id. */
function parseKeys(env: Record<string, string | undefined>): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const [name, raw] of Object.entries(env)) {
    const match = /^SEX_SEARCH_([A-Z0-9_]+)_KEY$/.exec(name);
    const id = match?.[1]?.toLowerCase();
    const value = text(raw);
    if (id && value) keys[id] = value;
  }
  return keys;
}

const text = (value: string | undefined): string | undefined => value?.trim() || undefined;

function integer(value: string | undefined, fallback: number, name: string): number {
  const raw = text(value);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return parsed;
}

function flag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(text(value) ?? "");
}

function choice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T | undefined,
  name: string,
): T | undefined {
  const raw = text(value);
  if (!raw) return fallback;
  if (!allowed.includes(raw as T)) throw new Error(`${name} must be one of ${allowed.join(", ")}, got "${raw}"`);
  return raw as T;
}
