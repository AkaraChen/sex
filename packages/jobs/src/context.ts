import { llmRequired } from "@searxng-js/sex-errors";
import type { MapContext } from "@searxng-js/sex-map";
import type { ScrapeLlm } from "@searxng-js/sex-scrape";
import type { JobBackend } from "./backend.ts";

type Schema = Record<string, unknown>;
type CallTime = Parameters<ScrapeLlm["summarize"]>[1];

/** The settings of the jobs themselves; how pages are fetched is `settings` of the scrape context. */
export interface JobsSettings {
  /** Pages an extract scrapes at once. */
  concurrency: number;
  /** Pages a `/*` URL of an extract expands to when the request has no `limit`. */
  extractWildcardPages: number;
  /** Signs webhook bodies (`X-Firecrawl-Signature: sha256=<hmac>`) when set. */
  webhookSecret?: string;
}

/** The LLM calls an extract and a crawl `prompt` make, on top of a scrape's. `Llm` of sex-llm satisfies it. */
export interface JobsLlm extends ScrapeLlm {
  /** Throws when the LLM is not configured. */
  require(what: string): unknown;
  /** Adds the tokens of every LLM call `fn` makes to `meter.tokens`. The meter is per run, not per client. */
  metered<T>(meter: { tokens: number }, fn: () => Promise<T>): Promise<T>;
  /** The description of the `is_content_relevant` field that multi-entity extraction adds to a schema. */
  readonly relevanceFieldDescription: string;
  /** The problems of `value` against a JSON Schema, one line each; empty when it matches. */
  schemaErrors(schema: Schema, value: unknown): string[];
  extractJson(
    content: string,
    opts: { prompt?: string; schema?: Schema; systemPrompt?: string; urls?: string[]; url?: string },
    time: CallTime,
  ): Promise<unknown>;
  planExtract(
    schema: Schema,
    prompt: string | undefined,
    urls: string[],
    time: CallTime,
  ): Promise<{ isMultiEntity: boolean; multiEntityKeys: string[] }>;
  generateSchema(prompt: string, time: CallTime): Promise<Schema>;
  crawlOptions(url: string, prompt: string, time: CallTime, siteUrls?: string[]): Promise<Record<string, unknown>>;
  selectLinks(
    candidates: Array<{ url: string; title?: string; description?: string }>,
    query: string,
    max: number,
    time: CallTime,
  ): Promise<Array<{ url: string; title?: string; description?: string }>>;
}

/**
 * What the jobs run on: a map context (which is a search context, which is a scrape context), the job store and queue, and
 * for an extract the LLM and a web search. A plain object or a class instance; sex's `Engine` is one.
 */
export type JobsContext = MapContext & {
  readonly jobs: JobBackend;
  readonly jobSettings: JobsSettings;
  readonly llm?: JobsLlm;
  /** The web search an extract without URLs (or with `enableWebSearch`) starts from. */
  search(req: { query: string; limit?: number }, signal?: AbortSignal): Promise<{ data: { web?: Array<{ url: string }> } }>;
};

/** The context's LLM, or the 501 for a feature that needs one. */
export function requireLlm(ctx: JobsContext, what: string): JobsLlm {
  if (!ctx.llm?.enabled) throw llmRequired(what, ctx.missingHints?.llm);
  return ctx.llm;
}
