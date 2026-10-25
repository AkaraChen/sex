import { z } from "zod";
import { AppError } from "./errors.ts";

export interface Config {
  searxngUrl: string;
  /** CDP endpoint of an already running browser (ws:// or http://). */
  cdpUrl?: string;
  /** Spawn a local Lightpanda process and use it as the browser. */
  lightpanda: boolean;
  lightpandaPath?: string;
  llm?: { baseUrl: string; apiKey?: string; model: string };
  /** Allow fetching loopback / private / link-local addresses. */
  allowPrivateNetwork: boolean;
  userAgent: string;
  /** Global cap on concurrent page scrapes. */
  concurrency: number;
  /** Default per-page timeout in ms. */
  timeout: number;
  /** Redis URL for BullMQ jobs; in-memory queue when unset. */
  redisUrl?: string;
  redisPrefix: string;
  /** Max characters of page content sent to the LLM in one call. */
  llmMaxInputChars: number;
  /** Max response body size in bytes for a single page fetch. */
  maxBodyBytes: number;
  /** How long finished jobs are kept, in ms. */
  jobTtlMs: number;
  /** Pages mapped for an extract URL ending in `/*`. */
  extractWildcardPages: number;
}

/** Values given on the command line; anything missing falls back to SEX_* env vars, then defaults. */
export interface ConfigOverrides {
  searxngUrl?: string;
  cdpUrl?: string;
  lightpanda?: boolean;
  lightpandaPath?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  allowPrivateNetwork?: boolean;
  userAgent?: string;
  concurrency?: number;
  timeout?: number;
  redisUrl?: string;
  redisPrefix?: string;
  llmMaxInputChars?: number;
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
  maxBodyBytes: intField(1024),
  jobTtlMs: intField(60_000),
  extractWildcardPages: intField(1),
  llmMaxInputChars: intField(1000),
  searxngUrl: urlField,
  llmBaseUrl: urlField,
  lightpanda: flagField,
  allowPrivateNetwork: flagField,
});

/** Env name (or label) and the human description used in CONFIG_INVALID messages. */
const FIELD_RULES: Record<keyof z.infer<typeof RAW_SCHEMA>, [name: string, expected: string]> = {
  concurrency: ["SEX_CONCURRENCY", "an integer >= 1"],
  timeout: ["SEX_TIMEOUT", "an integer >= 1"],
  maxBodyBytes: ["SEX_MAX_BODY_BYTES", "an integer >= 1024"],
  jobTtlMs: ["SEX_JOB_TTL_MS", "an integer >= 60000 (milliseconds)"],
  extractWildcardPages: ["SEX_EXTRACT_WILDCARD_PAGES", "an integer >= 1"],
  llmMaxInputChars: ["SEX_LLM_MAX_INPUT_CHARS", "an integer >= 1000"],
  searxngUrl: ["SEX_SEARXNG_URL", "an http(s) URL"],
  llmBaseUrl: ["SEX_LLM_BASE_URL", "an http(s) URL"],
  lightpanda: ["SEX_LIGHTPANDA", `one of ${[...TRUE_WORDS, ...FALSE_WORDS].join(", ")}`],
  allowPrivateNetwork: ["SEX_ALLOW_PRIVATE_NETWORK", `one of ${[...TRUE_WORDS, ...FALSE_WORDS].join(", ")}`],
};

/** A boolean override arrives as a real boolean; normalise it to the same word form env values use. */
const flag = (override: boolean | undefined, envValue: string | undefined) => (override !== undefined ? String(override) : envValue);

export function resolveConfig(
  o: ConfigOverrides = {},
  defaults: { allowPrivateNetwork: boolean } = { allowPrivateNetwork: false },
  env: Env = process.env,
): Config {
  const raw = {
    concurrency: o.concurrency ?? str(env.SEX_CONCURRENCY),
    timeout: o.timeout ?? str(env.SEX_TIMEOUT),
    maxBodyBytes: str(env.SEX_MAX_BODY_BYTES),
    jobTtlMs: str(env.SEX_JOB_TTL_MS),
    extractWildcardPages: str(env.SEX_EXTRACT_WILDCARD_PAGES),
    llmMaxInputChars: o.llmMaxInputChars ?? str(env.SEX_LLM_MAX_INPUT_CHARS),
    searxngUrl: str(o.searxngUrl) ?? str(env.SEX_SEARXNG_URL),
    llmBaseUrl: str(o.llmBaseUrl) ?? str(env.SEX_LLM_BASE_URL) ?? str(env.OPENAI_BASE_URL),
    lightpanda: flag(o.lightpanda, str(env.SEX_LIGHTPANDA)),
    allowPrivateNetwork: flag(o.allowPrivateNetwork, str(env.SEX_ALLOW_PRIVATE_NETWORK)),
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
    redisUrl: str(o.redisUrl) ?? str(env.SEX_REDIS_URL),
    redisPrefix: str(o.redisPrefix) ?? str(env.SEX_REDIS_PREFIX) ?? "sex",
    llmMaxInputChars: v.llmMaxInputChars ?? 200_000,
    maxBodyBytes: v.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    jobTtlMs: v.jobTtlMs ?? 24 * 60 * 60 * 1000,
    extractWildcardPages: v.extractWildcardPages ?? 25,
  };
}
