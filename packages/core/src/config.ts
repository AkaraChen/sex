import { z } from "zod";
import { AppError } from "./errors.ts";

/** The settings the shared engine (search, fetch, HTTP/MCP front-ends) reads; sex extends it with its own. */
export interface CoreConfig {
  /** External SearXNG base URL; when unset, SearXNG runs as a child process. */
  searxngUrl?: string;
  /** SearXNG executable for the managed instance (default: the bundled binary). */
  searxngPath?: string;
  /** settings.yml for the managed instance (default: a minimal one with the JSON API on). */
  searxngSettings?: string;
  /** Allow fetching loopback / private / link-local addresses. */
  allowPrivateNetwork: boolean;
  /** Outbound http(s) proxy for every fetch of a user-supplied URL (plain HTTP and the browser); SEX_PROXY_URL, env only. */
  proxyUrl?: string;
  /**
   * A second outbound proxy (same shape as `proxyUrl`) that a fetch blocked by the site is retried through once; SEX_STEALTH_PROXY_URL, env only.
   * Unset: no retry, and `proxy: "stealth"` is not available.
   */
  stealthProxyUrl?: string;
  userAgent: string;
  /** Global cap on concurrent page scrapes. */
  concurrency: number;
  /** Default per-page timeout in ms. */
  timeout: number;
  /** Max response body size in bytes for a single page fetch. */
  maxBodyBytes: number;
  /** Worker threads for HTML/PDF extraction; 0 runs extraction on the main thread. */
  extractWorkers: number;
  /** Browser origins allowed to call the HTTP API and MCP endpoint cross-origin (CORS). Empty disables CORS. */
  corsOrigins: string[];
  /** Host header hostnames accepted by the HTTP API and MCP endpoint; empty means only the bind-address check applies. */
  allowedHosts: string[];
  /** Reject request fields the schema does not declare with 400 instead of dropping them (HTTP API; SEX_STRICT_REQUESTS). */
  strictRequests: boolean;
}

/** Values given on the command line; anything missing falls back to SEX_* env vars, then defaults. */
export interface CoreConfigOverrides {
  searxngUrl?: string;
  searxngPath?: string;
  searxngSettings?: string;
  allowPrivateNetwork?: boolean;
  userAgent?: string;
  concurrency?: number;
  timeout?: number;
  /** Comma-separated origins, e.g. "https://app.example.com,https://other.example". */
  corsOrigins?: string;
  /** Comma-separated hostnames, e.g. "sex.example.com". */
  allowedHosts?: string;
}

export type Env = Record<string, string | undefined>;

/** Default body cap for a page fetch; also used by callers that do not pass a config. */
export const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;

const DEFAULT_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/**
 * Compose passes `${VAR:-}` for unset variables and citty passes "" for a bare flag,
 * so an empty or whitespace-only value counts as unset.
 */
export const str = (v: string | undefined): string | undefined => (v === undefined || v.trim() === "" ? undefined : v.trim());

export const intField = (min: number) => z.coerce.number().int().min(min).optional();
export const urlField = z.url({ protocol: /^https?$/ }).optional();
/** Splits a comma-separated value into trimmed, non-empty items. */
const csv = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
/** A bare origin: scheme, host and optional port, no path, query or trailing slash. */
const originField = z
  .url({ protocol: /^https?$/ })
  .refine((s) => new URL(s).origin === s.replace(/\/$/, "").toLowerCase(), "must be an origin without a path");
const corsOriginsField = z.string().optional().transform(csv).pipe(z.array(originField));
/** Hostnames only (no port, no scheme); IPv6 literals in brackets. */
const hostnameField = z.string().regex(/^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)$/, "must be a hostname without a port");
const allowedHostsField = z.string().optional().transform(csv).pipe(z.array(hostnameField));
const TRUE_WORDS = ["1", "true", "yes", "on"];
const FALSE_WORDS = ["0", "false", "no", "off"];
export const FLAG_WORDS = `one of ${[...TRUE_WORDS, ...FALSE_WORDS].join(", ")}`;
export const flagField = z
  .string()
  .toLowerCase()
  .pipe(z.enum([...TRUE_WORDS, ...FALSE_WORDS]))
  .transform((w) => TRUE_WORDS.includes(w))
  .optional();

/** Raw values of the core settings, already normalised to strings (or numbers from overrides) and checked here. */
export const CORE_FIELDS = {
  concurrency: intField(1),
  timeout: intField(1),
  maxBodyBytes: intField(1024),
  extractWorkers: intField(0),
  searxngUrl: urlField,
  allowPrivateNetwork: flagField,
  proxyUrl: urlField,
  stealthProxyUrl: urlField,
  corsOrigins: corsOriginsField,
  allowedHosts: allowedHostsField,
  strictRequests: flagField,
};

/** Env name (or label) and the human description used in CONFIG_INVALID messages. */
export type FieldRules<K extends string> = Record<K, [name: string, expected: string]>;

export const CORE_FIELD_RULES: FieldRules<keyof typeof CORE_FIELDS> = {
  concurrency: ["SEX_CONCURRENCY", "an integer >= 1"],
  timeout: ["SEX_TIMEOUT", "an integer >= 1"],
  maxBodyBytes: ["SEX_MAX_BODY_BYTES", "an integer >= 1024"],
  extractWorkers: ["SEX_EXTRACT_WORKERS", "an integer >= 0"],
  searxngUrl: ["SEX_SEARXNG_URL", "an http(s) URL"],
  allowPrivateNetwork: ["SEX_ALLOW_PRIVATE_NETWORK", FLAG_WORDS],
  proxyUrl: ["SEX_PROXY_URL", "an http(s) URL"],
  stealthProxyUrl: ["SEX_STEALTH_PROXY_URL", "an http(s) URL"],
  corsOrigins: ["SEX_CORS_ORIGINS", "comma-separated origins like https://app.example.com (no path)"],
  allowedHosts: ["SEX_ALLOWED_HOSTS", "comma-separated hostnames without a port"],
  strictRequests: ["SEX_STRICT_REQUESTS", FLAG_WORDS],
};

/** A boolean override arrives as a real boolean; normalise it to the same word form env values use. */
export const flag = (override: boolean | undefined, envValue: string | undefined) => (override !== undefined ? String(override) : envValue);

/** The raw (unchecked) core values: override first, then the SEX_* env var. */
export function coreRawValues(o: CoreConfigOverrides, env: Env) {
  return {
    concurrency: o.concurrency ?? str(env.SEX_CONCURRENCY),
    timeout: o.timeout ?? str(env.SEX_TIMEOUT),
    maxBodyBytes: str(env.SEX_MAX_BODY_BYTES),
    extractWorkers: str(env.SEX_EXTRACT_WORKERS),
    searxngUrl: str(o.searxngUrl) ?? str(env.SEX_SEARXNG_URL),
    allowPrivateNetwork: flag(o.allowPrivateNetwork, str(env.SEX_ALLOW_PRIVATE_NETWORK)),
    proxyUrl: str(env.SEX_PROXY_URL),
    stealthProxyUrl: str(env.SEX_STEALTH_PROXY_URL),
    corsOrigins: str(o.corsOrigins) ?? str(env.SEX_CORS_ORIGINS),
    allowedHosts: str(o.allowedHosts) ?? str(env.SEX_ALLOWED_HOSTS),
    strictRequests: str(env.SEX_STRICT_REQUESTS),
  };
}

/** Checks raw values against `fields`, throwing CONFIG_INVALID that names the first bad setting. */
export function parseFields<S extends z.ZodRawShape>(
  fields: S,
  rules: FieldRules<keyof S & string>,
  raw: Record<keyof S, unknown>,
): z.infer<z.ZodObject<S>> {
  const parsed = z.object(fields).safeParse(raw);
  if (!parsed.success) {
    const key = String(parsed.error.issues[0]?.path[0]) as keyof S & string;
    const [name, expected] = rules[key];
    const value = raw[key] as string | number;
    // A proxy URL usually carries credentials, which must not end up in an error message or a log.
    const shown = key === "proxyUrl" || key === "stealthProxyUrl" ? "<redacted>" : JSON.stringify(String(value));
    throw new AppError("CONFIG_INVALID", `${name} must be ${expected} (got ${shown})`);
  }
  return parsed.data;
}

/** The core config from checked values (`parseFields` over CORE_FIELDS, possibly with more fields). */
export function coreConfigFrom(
  v: z.infer<z.ZodObject<typeof CORE_FIELDS>>,
  o: CoreConfigOverrides,
  defaults: { allowPrivateNetwork: boolean },
  env: Env,
): CoreConfig {
  return {
    searxngUrl: v.searxngUrl?.replace(/\/+$/, ""),
    searxngPath: str(o.searxngPath) ?? str(env.SEX_SEARXNG_PATH),
    searxngSettings: str(o.searxngSettings) ?? str(env.SEX_SEARXNG_SETTINGS),
    allowPrivateNetwork: v.allowPrivateNetwork ?? defaults.allowPrivateNetwork,
    proxyUrl: v.proxyUrl,
    stealthProxyUrl: v.stealthProxyUrl,
    userAgent: str(o.userAgent) ?? str(env.SEX_USER_AGENT) ?? DEFAULT_UA,
    concurrency: v.concurrency ?? 8,
    timeout: v.timeout ?? 30_000,
    maxBodyBytes: v.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    extractWorkers: v.extractWorkers ?? Math.max(1, Math.min(4, navigator.hardwareConcurrency - 1)),
    corsOrigins: v.corsOrigins.map((o) => new URL(o).origin),
    allowedHosts: v.allowedHosts.map((h) => h.toLowerCase()),
    strictRequests: v.strictRequests ?? false,
  };
}

export function resolveCoreConfig(
  o: CoreConfigOverrides = {},
  defaults: { allowPrivateNetwork: boolean } = { allowPrivateNetwork: false },
  env: Env = process.env,
): CoreConfig {
  const v = parseFields(CORE_FIELDS, CORE_FIELD_RULES, coreRawValues(o, env));
  return coreConfigFrom(v, o, defaults, env);
}
