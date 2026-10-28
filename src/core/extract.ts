import pLimit from "p-limit";
import { AppError, badRequest, toAppError } from "../errors.ts";
import { log } from "../log.ts";
import type { ExtractRequest } from "../schemas.ts";
import { Deadline } from "./deadline.ts";
import type { Engine } from "./engine.ts";
import { arrayKeys, mergeAll, splitSchema, withProperty } from "./extract-merge.ts";
import type { JobRecord } from "./jobs/index.ts";
import { compileJsonSchema, describeSchemaErrors } from "./json-schema.ts";
import { GUARD_MAX_CHARS } from "./llm.ts";
import { mapSite } from "./map.ts";
import { assertPublicUrl, parseHttpUrl } from "./net.ts";
import { RELEVANCE_FIELD_DESCRIPTION } from "./prompts.ts";
import { assertScrapeCapabilities, scrapeUrl } from "./scrape.ts";
import { search } from "./search.ts";

const SEARCH_RESULTS = 5;

export async function startExtract(engine: Engine, req: ExtractRequest): Promise<{ job: JobRecord; invalidURLs?: string[] }> {
  engine.llm.require("Extract");
  if (!req.urls?.length && !(req.enableWebSearch && req.prompt)) {
    throw badRequest("Provide urls, or a prompt with enableWebSearch: true");
  }
  if (!req.prompt && !req.schema) throw badRequest("Provide a prompt and/or a schema");
  if (req.schema) compileJsonSchema(req.schema);
  assertScrapeCapabilities(engine, { ...req.scrapeOptions, formats: ["markdown"] });

  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of req.urls ?? []) {
    try {
      const url = parseHttpUrl(raw.trim().replace(/\/\*$/, "/"));
      await assertPublicUrl(url, engine.config.allowPrivateNetwork);
      valid.push(raw.trim().endsWith("/*") ? `${url.href}*` : url.href);
    } catch (err) {
      if (!req.ignoreInvalidURLs) throw err;
      invalid.push(raw);
    }
  }

  const job = await engine.jobs.store.create({ kind: "extract", options: { ...req, urls: valid } as Record<string, unknown> });
  await engine.jobs.queue.add([{ task: { type: "extract", jobId: job.id } }]);
  return { job, invalidURLs: req.ignoreInvalidURLs ? invalid : undefined };
}

/** How often a running extract checks whether its job was cancelled. */
const CANCEL_POLL_MS = 2000;

export async function handleExtract(engine: Engine, job: JobRecord) {
  const { store } = engine.jobs;
  // Cancelling a job finishes it in the store; poll for that so in-flight map/search/scrape/LLM work stops too.
  const controller = new AbortController();
  const timer = setInterval(async () => {
    try {
      const current = await store.get(job.id);
      if (current?.status !== "scraping") controller.abort();
    } catch {
      // A transient store error is retried on the next tick.
    }
  }, CANCEL_POLL_MS);
  try {
    const req = job.options as unknown as ExtractRequest;
    const { result, sources, warning, total, completed } = await runExtract(engine, job.id, req, req.urls ?? [], controller.signal);
    if (controller.signal.aborted) return;
    await store.incr(job.id, "total", total);
    await store.incr(job.id, "completed", completed);
    await store.finish(job.id, "completed", { result, sources, warning });
  } catch (err) {
    // Cancelled jobs were already finished by cancelJob; do not overwrite that.
    if (controller.signal.aborted) return;
    const e = toAppError(err);
    log.error("extract failed", { id: job.id, error: e.message });
    await store.finish(job.id, "failed", { error: e.message });
  } finally {
    clearInterval(timer);
  }
}

async function runExtract(engine: Engine, jobId: string, req: ExtractRequest, urls: string[], signal: AbortSignal) {
  const targets = new Set<string>();
  for (const u of urls) {
    if (u.endsWith("/*")) {
      const links = await mapSite(engine, { url: u.slice(0, -1), limit: engine.config.extractWildcardPages, search: req.prompt }, signal);
      for (const l of links) targets.add(l.url);
    } else targets.add(u);
  }
  if (req.enableWebSearch && req.prompt) {
    const { data } = await search(engine, { query: req.prompt, limit: SEARCH_RESULTS }, signal);
    for (const r of data.web ?? []) targets.add(r.url);
  }

  const limit = pLimit(engine.config.concurrency);
  const options = { ...req.scrapeOptions, formats: ["markdown" as const] };
  const warnings: string[] = [];
  const pages = await Promise.all(
    [...targets].map((url) =>
      limit(async () => {
        try {
          const { document } = await scrapeUrl(engine, url, options, { signal });
          if (document.warning) warnings.push(`${url}: ${document.warning}`);
          // The guard scans the first GUARD_MAX_CHARS of a page (scrapeUrl warns about the rest); only that part goes on.
          const markdown = document.markdown ?? "";
          return { url, markdown: options.checkPromptInjection ? markdown.slice(0, GUARD_MAX_CHARS) : markdown };
        } catch (err) {
          if (signal.aborted) return undefined;
          await engine.jobs.store.pushError(jobId, {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            url,
            error: toAppError(err).message,
          });
          return undefined;
        }
      }),
    ),
  );
  const ok = pages.filter((p): p is Page => !!p && p.markdown.trim().length > 0);
  if (!ok.length) throw new Error(`Could not scrape any of the ${targets.size} source pages`);

  const { result, used } = await extractFromPages(engine, req, ok, limit, signal, (url, err) =>
    engine.jobs.store.pushError(jobId, {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      url,
      error: toAppError(err).message,
    }),
  );

  return {
    result,
    sources: req.showSources ? { "*": used } : undefined,
    warning: warnings.length ? warnings.join("; ") : undefined,
    total: targets.size,
    completed: ok.length,
  };
}

interface Page {
  url: string;
  markdown: string;
}

type Limit = ReturnType<typeof pLimit>;
type Schema = Record<string, unknown>;

/** Firecrawl's per-page relevance flag, added to multi-entity extraction and stripped from results. */
const RELEVANT = "is_content_relevant";

/**
 * Firecrawl's extract flow:
 * 1. A prompt without a schema gets a generated schema, so every page answers in the same shape.
 * 2. A schema with arrays is classified Single-Answer or Multi-Entity. Multi-entity keys are
 *    extracted page by page (each answer says whether its page was relevant) and merged in code.
 * 3. The remaining keys are one answer from all pages together, packed into as few LLM calls as
 *    the input budget allows and merged in code when it takes more than one.
 */
async function extractFromPages(
  engine: Engine,
  req: ExtractRequest,
  pages: Page[],
  limit: Limit,
  signal: AbortSignal,
  onError: (url: string, err: unknown) => Promise<void>,
): Promise<{ result: unknown; used: string[] }> {
  const { llm } = engine;
  // An extract has no time limit of its own: it ends when the job is cancelled, and each LLM call has SEX_LLM_TIMEOUT.
  const deadline = Deadline.unbounded(signal);
  const opts = { prompt: req.prompt, systemPrompt: req.systemPrompt, urls: pages.map((p) => p.url) };

  let schema = req.schema;
  if (!schema && req.prompt) {
    try {
      schema = await llm.generateSchema(req.prompt, deadline);
      log.debug("generated extract schema", { schema });
    } catch (err) {
      if (signal.aborted) throw err;
      log.warn("could not generate a schema for the extract; extracting without one", { error: toAppError(err).message });
    }
  }

  let multi: Schema | undefined;
  let single: Schema | undefined = schema;
  if (schema && isArrayRoot(schema)) {
    multi = schema;
    single = undefined;
  } else if (schema && arrayKeys(schema).length) {
    try {
      const plan = await llm.planExtract(schema, req.prompt, opts.urls, deadline);
      log.debug("extract plan", { ...plan });
      if (plan.isMultiEntity) ({ multi, single } = splitSchema(schema, plan.multiEntityKeys));
    } catch (err) {
      if (signal.aborted) throw err;
      log.warn("could not classify the extract; treating it as a single answer", { error: toAppError(err).message });
    }
  }

  const used = new Set<string>();
  const parts: unknown[] = [];
  const run = async (url: string, task: () => Promise<unknown>, errors: unknown[]) => {
    try {
      return await task();
    } catch (err) {
      if (signal.aborted) throw err;
      errors.push(err);
      await onError(url, err);
      return undefined;
    }
  };

  if (multi) {
    // One call per page (or per piece of a page over the budget), so no entity is cut off.
    const rootArray = isArrayRoot(multi);
    const sent = rootArray ? multi : withProperty(multi, RELEVANT, RELEVANCE_FIELD_DESCRIPTION);
    const pieces = pages.flatMap((p) => chunkText(p.markdown, llm.maxInputChars).map((text) => ({ url: p.url, text })));
    const errors: unknown[] = [];
    const results = await Promise.all(
      pieces.map((piece) =>
        limit(() =>
          run(
            piece.url,
            async () => {
              const v = await llm.extractJson(piece.text, { ...opts, schema: sent, url: piece.url }, deadline);
              if (!rootArray) {
                if (!v || typeof v !== "object" || (v as Record<string, unknown>)[RELEVANT] === false) return undefined;
                delete (v as Record<string, unknown>)[RELEVANT];
              }
              used.add(piece.url);
              return v;
            },
            errors,
          ),
        ),
      ),
    );
    const found = results.filter((r) => r !== undefined);
    if (!found.length && errors.length) throw errors[0];
    parts.push(mergeAll([emptyArrays(multi), ...found]));
  }

  if (single || !schema) {
    const chunks = packPages(pages, llm.maxInputChars);
    const errors: unknown[] = [];
    const results = await Promise.all(
      chunks.map((c) =>
        limit(() =>
          run(
            c.urls[0] ?? "",
            async () => {
              const v = await llm.extractJson(
                c.text,
                { ...opts, schema: single, url: c.urls.length === 1 ? c.urls[0] : undefined },
                deadline,
              );
              for (const u of c.urls) used.add(u);
              return v;
            },
            errors,
          ),
        ),
      ),
    );
    const found = results.filter((r) => r !== undefined);
    if (!found.length && errors.length) throw errors[0];
    parts.push(mergeAll(found));
  }

  const result = mergeAll(parts);
  if (schema) {
    const validate = compileJsonSchema(schema);
    if (!validate(result)) {
      const errors = describeSchemaErrors(validate.errors);
      throw new AppError("LLM_INVALID_OUTPUT", `Merged extract result does not match the JSON Schema: ${errors.join("; ")}`, {
        errors,
      });
    }
  }
  return { result, used: pages.map((p) => p.url).filter((u) => used.has(u)) };
}

function isArrayRoot(schema: Schema): boolean {
  const t = schema.type;
  return t === "array" || (Array.isArray(t) && t.includes("array") && !t.includes("object"));
}

/** `[]` for each array property (or `[]` for a root array), so entity keys exist even when no page had any. */
function emptyArrays(schema: Schema): unknown {
  if (isArrayRoot(schema)) return [];
  const props = (schema.properties ?? {}) as Record<string, Schema>;
  return Object.fromEntries(
    Object.entries(props)
      .filter(([, s]) => s?.type === "array")
      .map(([k]) => [k, []]),
  );
}

/** Splits text into pieces of at most `size` characters, cutting at a line break where one is near. */
function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf("\n", size);
    const at = cut > size / 2 ? cut + 1 : size;
    out.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest.trim() || !out.length) out.push(rest);
  return out;
}

/** Packs pages, each under a `## Source:` heading, into as few chunks of at most `budget` characters as possible. */
function packPages(pages: Page[], budget: number): Array<{ text: string; urls: string[] }> {
  const chunks: Array<{ text: string; urls: string[] }> = [];
  let current = { text: "", urls: [] as string[] };
  for (const p of pages) {
    const header = `## Source: ${p.url}\n\n`;
    for (const piece of chunkText(p.markdown, budget - header.length)) {
      const block = `${header}${piece}\n\n`;
      if (current.text && current.text.length + block.length > budget) {
        chunks.push(current);
        current = { text: "", urls: [] };
      }
      current.text += block;
      if (!current.urls.includes(p.url)) current.urls.push(p.url);
    }
  }
  if (current.text) chunks.push(current);
  return chunks;
}
