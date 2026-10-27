import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AppError } from "./errors.ts";

export interface Config {
  searxngUrl: string;
  /** CDP endpoint of an already running browser (ws:// or http://). */
  cdpUrl?: string;
  /** Spawn a local Lightpanda process and use it as the browser. */
  lightpanda: boolean;
  lightpandaPath?: string;
  /** Convert PDFs, office documents and images with here-docs (structured text + OCR). */
  docs: boolean;
  llm?: { baseUrl: string; apiKey?: string; model: string };
  /** Allow fetching loopback / private / link-local addresses. */
  allowPrivateNetwork: boolean;
  userAgent: string;
  /** Global cap on concurrent page scrapes. */
  concurrency: number;
  /** Default per-page timeout in ms. */
  timeout: number;
  /** Deadline for a single LLM request in ms. */
  llmTimeout: number;
  /** Directory for the job database and task queue (SQLite); jobs are kept in memory when unset. */
  dataDir?: string;
  /** Max characters of page content sent to the LLM in one call. */
  llmMaxInputChars: number;
  /** Max response body size in bytes for a single page fetch. */
  maxBodyBytes: number;
  /** How long finished jobs are kept, in ms. */
  jobTtlMs: number;
  /** Pages mapped for an extract URL ending in `/*`. */
  extractWildcardPages: number;
  /** Worker threads for HTML/PDF extraction; 0 runs extraction on the main thread. */
  extractWorkers: number;
  /** Browser origins allowed to call the HTTP API and MCP endpoint cross-origin (CORS). Empty disables CORS. */
  corsOrigins: string[];
  /** Host header hostnames accepted by the HTTP API and MCP endpoint; empty means only the bind-address check applies. */
  allowedHosts: string[];
}

/** Values given on the command line; anything missing falls back to SEX_* env vars, then defaults. */
export interface ConfigOverrides {
  searxngUrl?: string;
  cdpUrl?: string;
  lightpanda?: boolean;
  lightpandaPath?: string;
  docs?: boolean;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  allowPrivateNetwork?: boolean;
  userAgent?: string;
  concurrency?: number;
  timeout?: number;
  llmTimeout?: number;
  dataDir?: string;
  llmMaxInputChars?: number;
  /** Comma-separated origins, e.g. "https://app.example.com,https://other.example". */
  corsOrigins?: string;
  /** Comma-separated hostnames, e.g. "sex.example.com". */
  allowedHosts?: string;
}

type Env = Record<string, string | undefined>;

/** Default body cap for a page fetch; also used by callers that do not pass a config. */
export const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;

const DEFAULT_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const DEFAULT_SEARXNG_URL = "http://127.0.0.1:8080";
const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";

/**
 * Compose passes `${VAR:-}` for unset variables and citty passes "" for a bare flag,
 * so an empty or whitespace-only value counts as unset.
 */
const str = (v: string | undefined): string | undefined => (v === undefined || v.trim() === "" ? undefined : v.trim());

const intField = (min: number) => z.coerce.number().int().min(min).optional();
const urlField = z.url({ protocol: /^https?$/ }).optional();
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
const flagField = z
  .string()
  .toLowerCase()
  .pipe(z.enum([...TRUE_WORDS, ...FALSE_WORDS]))
  .transform((w) => TRUE_WORDS.includes(w))
  .optional();

/** Raw values, already normalised to strings (or numbers from overrides) and checked here. */
const RAW_SCHEMA = z.object({
  concurrency: intField(1),
  timeout: intField(1),
  llmTimeout: intField(1000),
  maxBodyBytes: intField(1024),
  jobTtlMs: intField(60_000),
  extractWildcardPages: intField(1),
  extractWorkers: intField(0),
  llmMaxInputChars: intField(1000),
  searxngUrl: urlField,
  llmBaseUrl: urlField,
  lightpanda: flagField,
  docs: flagField,
  allowPrivateNetwork: flagField,
  corsOrigins: corsOriginsField,
  allowedHosts: allowedHostsField,
});

/** Env name (or label) and the human description used in CONFIG_INVALID messages. */
const FIELD_RULES: Record<keyof z.infer<typeof RAW_SCHEMA>, [name: string, expected: string]> = {
  concurrency: ["SEX_CONCURRENCY", "an integer >= 1"],
  timeout: ["SEX_TIMEOUT", "an integer >= 1"],
  llmTimeout: ["SEX_LLM_TIMEOUT", "an integer >= 1000 (milliseconds)"],
  maxBodyBytes: ["SEX_MAX_BODY_BYTES", "an integer >= 1024"],
  jobTtlMs: ["SEX_JOB_TTL_MS", "an integer >= 60000 (milliseconds)"],
  extractWildcardPages: ["SEX_EXTRACT_WILDCARD_PAGES", "an integer >= 1"],
  extractWorkers: ["SEX_EXTRACT_WORKERS", "an integer >= 0"],
  llmMaxInputChars: ["SEX_LLM_MAX_INPUT_CHARS", "an integer >= 1000"],
  searxngUrl: ["SEX_SEARXNG_URL", "an http(s) URL"],
  llmBaseUrl: ["SEX_LLM_BASE_URL", "an http(s) URL"],
  lightpanda: ["SEX_LIGHTPANDA", `one of ${[...TRUE_WORDS, ...FALSE_WORDS].join(", ")}`],
  docs: ["SEX_DOCS", `one of ${[...TRUE_WORDS, ...FALSE_WORDS].join(", ")}`],
  allowPrivateNetwork: ["SEX_ALLOW_PRIVATE_NETWORK", `one of ${[...TRUE_WORDS, ...FALSE_WORDS].join(", ")}`],
  corsOrigins: ["SEX_CORS_ORIGINS", "comma-separated origins like https://app.example.com (no path)"],
  allowedHosts: ["SEX_ALLOWED_HOSTS", "comma-separated hostnames without a port"],
};

/** A boolean override arrives as a real boolean; normalise it to the same word form env values use. */
const flag = (override: boolean | undefined, envValue: string | undefined) => (override !== undefined ? String(override) : envValue);

/** Where `serve` keeps jobs when SEX_DATA_DIR is not set: $XDG_DATA_HOME/sex, else ~/.local/share/sex. */
export function defaultDataDir(env: Env = process.env): string {
  return join(str(env.XDG_DATA_HOME) ?? join(homedir(), ".local", "share"), "sex");
}

export function resolveConfig(
  o: ConfigOverrides = {},
  defaults: { allowPrivateNetwork: boolean; dataDir?: string } = { allowPrivateNetwork: false },
  env: Env = process.env,
): Config {
  for (const name of ["SEX_REDIS_URL", "SEX_REDIS_PREFIX"]) {
    if (str(env[name])) {
      throw new AppError(
        400,
        "CONFIG_INVALID",
        `${name} is no longer supported: jobs run in the sex process and are stored in SQLite under SEX_DATA_DIR. Unset ${name}.`,
      );
    }
  }
  const raw = {
    concurrency: o.concurrency ?? str(env.SEX_CONCURRENCY),
    timeout: o.timeout ?? str(env.SEX_TIMEOUT),
    llmTimeout: o.llmTimeout ?? str(env.SEX_LLM_TIMEOUT),
    maxBodyBytes: str(env.SEX_MAX_BODY_BYTES),
    jobTtlMs: str(env.SEX_JOB_TTL_MS),
    extractWildcardPages: str(env.SEX_EXTRACT_WILDCARD_PAGES),
    extractWorkers: str(env.SEX_EXTRACT_WORKERS),
    llmMaxInputChars: o.llmMaxInputChars ?? str(env.SEX_LLM_MAX_INPUT_CHARS),
    searxngUrl: str(o.searxngUrl) ?? str(env.SEX_SEARXNG_URL),
    llmBaseUrl: str(o.llmBaseUrl) ?? str(env.SEX_LLM_BASE_URL) ?? str(env.OPENAI_BASE_URL),
    lightpanda: flag(o.lightpanda, str(env.SEX_LIGHTPANDA)),
    docs: flag(o.docs, str(env.SEX_DOCS)),
    allowPrivateNetwork: flag(o.allowPrivateNetwork, str(env.SEX_ALLOW_PRIVATE_NETWORK)),
    corsOrigins: str(o.corsOrigins) ?? str(env.SEX_CORS_ORIGINS),
    allowedHosts: str(o.allowedHosts) ?? str(env.SEX_ALLOWED_HOSTS),
  };
  const parsed = RAW_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    const key = String(parsed.error.issues[0]?.path[0]) as keyof typeof FIELD_RULES;
    const [name, expected] = FIELD_RULES[key];
    const value = raw[key] as string | number;
    throw new AppError(400, "CONFIG_INVALID", `${name} must be ${expected} (got ${JSON.stringify(String(value))})`);
  }
  const v = parsed.data;

  const searxngUrl = v.searxngUrl ?? DEFAULT_SEARXNG_URL;
  const llmModel = str(o.llmModel) ?? str(env.SEX_LLM_MODEL);
  return {
    searxngUrl: searxngUrl.replace(/\/+$/, ""),
    cdpUrl: str(o.cdpUrl) ?? str(env.SEX_CDP_URL),
    lightpanda: v.lightpanda ?? false,
    lightpandaPath: str(o.lightpandaPath) ?? str(env.SEX_LIGHTPANDA_PATH) ?? str(env.LIGHTPANDA_EXECUTABLE_PATH),
    docs: v.docs ?? false,
    llm: llmModel
      ? {
          baseUrl: (v.llmBaseUrl ?? DEFAULT_LLM_BASE_URL).replace(/\/+$/, ""),
          apiKey: str(o.llmApiKey) ?? str(env.SEX_LLM_API_KEY) ?? str(env.OPENAI_API_KEY),
          model: llmModel,
        }
      : undefined,
    allowPrivateNetwork: v.allowPrivateNetwork ?? defaults.allowPrivateNetwork,
    userAgent: str(o.userAgent) ?? str(env.SEX_USER_AGENT) ?? DEFAULT_UA,
    concurrency: v.concurrency ?? 8,
    timeout: v.timeout ?? 30_000,
    llmTimeout: v.llmTimeout ?? 120_000,
    dataDir: str(o.dataDir) ?? str(env.SEX_DATA_DIR) ?? defaults.dataDir,
    llmMaxInputChars: v.llmMaxInputChars ?? 200_000,
    maxBodyBytes: v.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    jobTtlMs: v.jobTtlMs ?? 24 * 60 * 60 * 1000,
    extractWildcardPages: v.extractWildcardPages ?? 25,
    extractWorkers: v.extractWorkers ?? Math.max(1, Math.min(4, navigator.hardwareConcurrency - 1)),
    corsOrigins: v.corsOrigins.map((o) => new URL(o).origin),
    allowedHosts: v.allowedHosts.map((h) => h.toLowerCase()),
  };
}
