import { homedir } from "node:os";
import { join } from "node:path";
import {
  CORE_FIELD_RULES,
  CORE_FIELDS,
  type CoreConfig,
  type CoreConfigOverrides,
  coreConfigFrom,
  coreRawValues,
  type Env,
  type FieldRules,
  FLAG_WORDS,
  flag,
  flagField,
  intField,
  parseFields,
  str,
  urlField,
} from "@sex/core/config.ts";
import { AppError } from "@sex/core/errors.ts";
import { z } from "zod";

export { DEFAULT_MAX_BODY_BYTES } from "@sex/core/config.ts";

export interface Config extends CoreConfig {
  /** CDP endpoint of an already running browser (ws:// or http://). */
  cdpUrl?: string;
  /** Spawn a local Lightpanda process and use it as the browser. */
  lightpanda: boolean;
  lightpandaPath?: string;
  /** Abort image and audio / video requests of browser scrapes. */
  blockMedia: boolean;
  /** Convert PDFs, office documents and images with here-docs (structured text + OCR). */
  docs: boolean;
  llm?: { baseUrl: string; apiKey?: string; model: string };
  /** Deadline for a single LLM request in ms. */
  llmTimeout: number;
  /** Directory for the job database and task queue (SQLite); jobs are kept in memory when unset. */
  dataDir?: string;
  /** Where scraped documents of jobs go: `s3://bucket[/prefix]` or `file:///absolute/path`; unset means `<dataDir>/documents` (memory without a data dir). */
  documentsUrl?: string;
  /** Max characters of page content sent to the LLM in one call. */
  llmMaxInputChars: number;
  /** How long finished jobs are kept, in ms. */
  jobTtlMs: number;
  /** Pages mapped for an extract URL ending in `/*`. */
  extractWildcardPages: number;
}

/** Values given on the command line; anything missing falls back to SEX_* env vars, then defaults. */
export interface ConfigOverrides extends CoreConfigOverrides {
  cdpUrl?: string;
  lightpanda?: boolean;
  lightpandaPath?: string;
  blockMedia?: boolean;
  docs?: boolean;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  llmTimeout?: number;
  dataDir?: string;
  documentsUrl?: string;
  llmMaxInputChars?: number;
}

const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";

/** `s3://bucket[/prefix]` (a bucket is required) or `file:///absolute/path` (no host). */
const documentsUrlField = z
  .string()
  .refine((s) => {
    if (!URL.canParse(s)) return false;
    const url = new URL(s);
    if (url.search || url.hash) return false;
    if (url.protocol === "s3:") return url.hostname !== "";
    return url.protocol === "file:" && url.host === "" && url.pathname !== "/";
  })
  .optional();

/** The settings sex adds to the core ones, checked the same way. */
const FIELDS = {
  ...CORE_FIELDS,
  llmTimeout: intField(1000),
  jobTtlMs: intField(60_000),
  extractWildcardPages: intField(1),
  llmMaxInputChars: intField(1000),
  llmBaseUrl: urlField,
  lightpanda: flagField,
  blockMedia: flagField,
  docs: flagField,
  documentsUrl: documentsUrlField,
};

const FIELD_RULES: FieldRules<keyof typeof FIELDS> = {
  ...CORE_FIELD_RULES,
  llmTimeout: ["SEX_LLM_TIMEOUT", "an integer >= 1000 (milliseconds)"],
  jobTtlMs: ["SEX_JOB_TTL_MS", "an integer >= 60000 (milliseconds)"],
  extractWildcardPages: ["SEX_EXTRACT_WILDCARD_PAGES", "an integer >= 1"],
  llmMaxInputChars: ["SEX_LLM_MAX_INPUT_CHARS", "an integer >= 1000"],
  llmBaseUrl: ["SEX_LLM_BASE_URL", "an http(s) URL"],
  lightpanda: ["SEX_LIGHTPANDA", FLAG_WORDS],
  blockMedia: ["SEX_BLOCK_MEDIA", FLAG_WORDS],
  docs: ["SEX_DOCS", FLAG_WORDS],
  documentsUrl: ["SEX_DOCUMENTS_URL", "an s3://bucket[/prefix] or file:///absolute/path URL"],
};

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
        "CONFIG_INVALID",
        `${name} is no longer supported: jobs run in the sex process and are stored in SQLite under SEX_DATA_DIR. Unset ${name}.`,
      );
    }
  }
  const v = parseFields(FIELDS, FIELD_RULES, {
    ...coreRawValues(o, env),
    llmTimeout: o.llmTimeout ?? str(env.SEX_LLM_TIMEOUT),
    jobTtlMs: str(env.SEX_JOB_TTL_MS),
    extractWildcardPages: str(env.SEX_EXTRACT_WILDCARD_PAGES),
    llmMaxInputChars: o.llmMaxInputChars ?? str(env.SEX_LLM_MAX_INPUT_CHARS),
    llmBaseUrl: str(o.llmBaseUrl) ?? str(env.SEX_LLM_BASE_URL) ?? str(env.OPENAI_BASE_URL),
    lightpanda: flag(o.lightpanda, str(env.SEX_LIGHTPANDA)),
    blockMedia: flag(o.blockMedia, str(env.SEX_BLOCK_MEDIA)),
    docs: flag(o.docs, str(env.SEX_DOCS)),
    documentsUrl: str(o.documentsUrl) ?? str(env.SEX_DOCUMENTS_URL),
  });

  const llmModel = str(o.llmModel) ?? str(env.SEX_LLM_MODEL);
  return {
    ...coreConfigFrom(v, o, defaults, env),
    cdpUrl: str(o.cdpUrl) ?? str(env.SEX_CDP_URL),
    lightpanda: v.lightpanda ?? false,
    lightpandaPath: str(o.lightpandaPath) ?? str(env.SEX_LIGHTPANDA_PATH) ?? str(env.LIGHTPANDA_EXECUTABLE_PATH),
    blockMedia: v.blockMedia ?? false,
    docs: v.docs ?? false,
    llm: llmModel
      ? {
          baseUrl: (v.llmBaseUrl ?? DEFAULT_LLM_BASE_URL).replace(/\/+$/, ""),
          apiKey: str(o.llmApiKey) ?? str(env.SEX_LLM_API_KEY) ?? str(env.OPENAI_API_KEY),
          model: llmModel,
        }
      : undefined,
    llmTimeout: v.llmTimeout ?? 120_000,
    dataDir: str(o.dataDir) ?? str(env.SEX_DATA_DIR) ?? defaults.dataDir,
    documentsUrl: v.documentsUrl,
    llmMaxInputChars: v.llmMaxInputChars ?? 200_000,
    jobTtlMs: v.jobTtlMs ?? 24 * 60 * 60 * 1000,
    extractWildcardPages: v.extractWildcardPages ?? 25,
  };
}
