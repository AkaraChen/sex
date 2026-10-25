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
}

const DEFAULT_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function resolveConfig(
  o: ConfigOverrides = {},
  defaults: { allowPrivateNetwork: boolean } = { allowPrivateNetwork: false },
): Config {
  const env = process.env;
  const llmModel = o.llmModel ?? env.SEX_LLM_MODEL;
  return {
    searxngUrl: (o.searxngUrl ?? env.SEX_SEARXNG_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, ""),
    cdpUrl: o.cdpUrl ?? (env.SEX_CDP_URL || undefined),
    lightpanda: o.lightpanda ?? envBool("SEX_LIGHTPANDA") ?? false,
    lightpandaPath: o.lightpandaPath ?? (env.SEX_LIGHTPANDA_PATH || env.LIGHTPANDA_EXECUTABLE_PATH || undefined),
    llm: llmModel
      ? {
          baseUrl: (o.llmBaseUrl ?? env.SEX_LLM_BASE_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
          apiKey: o.llmApiKey ?? env.SEX_LLM_API_KEY ?? env.OPENAI_API_KEY,
          model: llmModel,
        }
      : undefined,
    allowPrivateNetwork: o.allowPrivateNetwork ?? envBool("SEX_ALLOW_PRIVATE_NETWORK") ?? defaults.allowPrivateNetwork,
    userAgent: o.userAgent ?? env.SEX_USER_AGENT ?? DEFAULT_UA,
    concurrency: o.concurrency ?? envInt("SEX_CONCURRENCY") ?? 8,
    timeout: o.timeout ?? envInt("SEX_TIMEOUT") ?? 30_000,
    redisUrl: o.redisUrl ?? (env.SEX_REDIS_URL || undefined),
    redisPrefix: env.SEX_REDIS_PREFIX || "sex",
    llmMaxInputChars: envInt("SEX_LLM_MAX_INPUT_CHARS") ?? 200_000,
  };
}
