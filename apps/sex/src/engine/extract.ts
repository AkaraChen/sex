import { assertPublicUrl, parseHttpUrl } from "@searxng-js/sex-egress";
import { AppError, badRequest, toAppError } from "@searxng-js/sex-errors";
import { GUARD_MAX_CHARS } from "@sex/core/capabilities.ts";
import { Deadline } from "@sex/core/deadline.ts";
import { log } from "@sex/core/log.ts";
import { assertScrapeCapabilities, scrapeUrl } from "@sex/core/scrape.ts";
import { search } from "@sex/core/search.ts";
import pLimit from "p-limit";
import type { ExtractRequest } from "../schemas.ts";
import type { Engine } from "./engine.ts";
import { arrayKeys, conflictingFields, entitySources, mergeAll, splitSchema, withProperty } from "./extract-merge.ts";
import { taskEffects } from "./jobs/effects.ts";
import { type JobRecord, sendWebhook, validateWebhook } from "./jobs/index.ts";
import { compileJsonSchema, describeSchemaErrors } from "./json-schema.ts";
import { TokenMeter } from "./llm.ts";
import { mapSite } from "./map.ts";
import { RELEVANCE_FIELD_DESCRIPTION } from "./prompts.ts";

/** Results of the web search a prompt without URLs starts from (Firecrawl's). */
const SEARCH_RESULTS = 10;

export async function startExtract(engine: Engine, req: ExtractRequest): Promise<{ job: JobRecord; invalidURLs?: string[] }> {
  engine.llm.require("Extract");
  // Without urls the prompt is searched for on the web; with urls, enableWebSearch adds the search to them.
  if (!req.urls?.length && !req.prompt) throw badRequest("Provide urls, or a prompt to search the web for");
  if (req.enableWebSearch && !req.prompt) throw badRequest("enableWebSearch needs a prompt to search for");
  if (!req.prompt && !req.schema) throw badRequest("Provide a prompt and/or a schema");
  if (req.schema) compileJsonSchema(req.schema);
  assertScrapeCapabilities(engine, { ...req.scrapeOptions, formats: ["markdown"] });
  await validateWebhook(engine, req.webhook);

  const ignoreInvalid = req.ignoreInvalidURLs ?? true;
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of req.urls ?? []) {
    try {
      const url = parseHttpUrl(raw.trim().replace(/\/\*$/, "/"));
      await assertPublicUrl(url, engine.config.allowPrivateNetwork);
      valid.push(raw.trim().endsWith("/*") ? `${url.href}*` : url.href);
    } catch (err) {
      if (!ignoreInvalid) throw err;
      invalid.push(raw);
    }
  }
  // Urls that were all dropped must not turn into a web search for the prompt.
  if (req.urls?.length && !valid.length) throw badRequest("No valid URLs to extract from", { invalidURLs: invalid });

  const job = await engine.jobs.store.create({ kind: "extract", options: { ...req, urls: valid } as Record<string, unknown> });
  await engine.jobs.scheduler.add([{ task: { type: "extract", jobId: job.id, taskId: crypto.randomUUID() } }]);
  return { job, invalidURLs: invalid.length ? invalid : undefined };
}

/** How often a running extract checks whether its job was cancelled. */
const CANCEL_POLL_MS = 2000;

export async function handleExtract(engine: Engine, job: JobRecord, taskId?: string) {
  const { store } = engine.jobs;
  const req = job.options as unknown as ExtractRequest;
  // Cancelling a job finishes it in the store; poll for that so in-flight map/search/scrape/LLM work stops too.
  // `timeout` aborts the same way, but fails the job instead of leaving it to whoever cancelled it.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setInterval(async () => {
    try {
      const current = await store.get(job.id);
      if (current?.status !== "scraping") controller.abort();
    } catch {
      // A transient store error is retried on the next tick.
    }
  }, CANCEL_POLL_MS);
  const deadline = req.timeout
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, req.timeout)
    : undefined;
  // Counted afresh by every run, and stored as absolute values with the job's end, so a redelivered extract does not add up.
  const meter = new TokenMeter();
  const fail = async (message: string) => {
    if (await store.finish(job.id, "failed", { error: message, tokensUsed: meter.tokens }))
      await sendWebhook(engine, job, "failed", [], message);
  };
  try {
    await taskEffects(engine, job, taskId).started();
    const out = await engine.llm.metered(meter, () => runExtract(engine, job.id, req, req.urls ?? [], controller.signal));
    if (timedOut) return await fail(`Extract timed out after ${req.timeout} ms`);
    if (controller.signal.aborted) return;
    const { result, sources, warning, total, completed } = out;
    if (await store.finish(job.id, "completed", { result, sources, warning, total, completed, tokensUsed: meter.tokens })) {
      await sendWebhook(engine, job, "completed", [result]);
    }
  } catch (err) {
    if (timedOut) return await fail(`Extract timed out after ${req.timeout} ms`);
    // Cancelled jobs were already finished by cancelJob; do not overwrite that.
    if (controller.signal.aborted) return;
    const e = toAppError(err);
    log.error("extract failed", { id: job.id, error: e.message });
    await fail(e.message);
  } finally {
    clearInterval(timer);
    clearTimeout(deadline);
  }
}

/** Pages mapped for a `/*` URL before the small model picks the relevant ones. */
const WILDCARD_CANDIDATES = 200;

async function runExtract(engine: Engine, jobId: string, req: ExtractRequest, urls: string[], signal: AbortSignal) {
  const targets = new Set<string>();
  const warnings: string[] = [];
  for (const u of urls) {
    if (u.endsWith("/*")) {
      for (const url of await expandWildcard(engine, u.slice(0, -1), req, signal, warnings)) targets.add(url);
    } else targets.add(u);
  }
  if (req.prompt && (req.enableWebSearch || !urls.length)) {
    const { data } = await search(engine, { query: req.prompt, limit: SEARCH_RESULTS }, signal);
    for (const r of data.web ?? []) targets.add(r.url);
  }

  const recordError = async (url: string, err: unknown) => {
    const e = toAppError(err);
    await engine.jobs.store.pushError(jobId, {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      url,
      error: e.message,
      code: e.code,
    });
  };
  const limit = pLimit(engine.config.concurrency);
  const options = { ...req.scrapeOptions, formats: ["markdown" as const] };
  const pages = await Promise.all(
    [...targets].map((url) =>
      limit(async () => {
        try {
          const { document } = await scrapeUrl(engine, url, options, { signal, llmOutsideTimeout: true });
          if (document.warning) warnings.push(`${url}: ${document.warning}`);
          // The guard scans the first GUARD_MAX_CHARS of a page (scrapeUrl warns about the rest); only that part goes on.
          const markdown = document.markdown ?? "";
          return { url, markdown: options.checkPromptInjection ? markdown.slice(0, GUARD_MAX_CHARS) : markdown };
        } catch (err) {
          if (signal.aborted) return undefined;
          await recordError(url, err);
          return undefined;
        }
      }),
    ),
  );
  const ok = pages.filter((p): p is Page => !!p && p.markdown.trim().length > 0);
  if (!ok.length) throw new Error(`Could not scrape any of the ${targets.size} source pages`);

  const { result, used, itemSources, notes } = await extractFromPages(engine, req, ok, limit, signal, recordError);
  warnings.push(...notes);

  return {
    result,
    // "*" lists every page the answer drew on; the other keys name the array items and the pages each came from.
    sources: req.showSources ? { "*": used, ...itemSources } : undefined,
    warning: warnings.length ? warnings.join("; ") : undefined,
    // Pages that failed are neither in the total nor completed (see JobCounters).
    total: ok.length,
    completed: ok.length,
  };
}

/**
 * The pages behind a `/*` URL: the site is mapped (the request's prompt, if any, ranks the candidates by keyword
 * count first), and with a prompt one small-model call picks the relevant `limit` out of the `WILDCARD_CANDIDATES`
 * best. A model that fails or picks nothing leaves the map's own first `limit`, which `warnings` says.
 */
async function expandWildcard(
  engine: Engine,
  base: string,
  req: ExtractRequest,
  signal: AbortSignal,
  warnings: string[],
): Promise<string[]> {
  const limit = req.limit ?? engine.config.extractWildcardPages;
  const { links } = await mapSite(
    engine,
    {
      url: base,
      limit: req.prompt ? Math.max(limit, WILDCARD_CANDIDATES) : limit,
      search: req.prompt,
      includeSubdomains: req.includeSubdomains,
    },
    signal,
  );
  if (!req.prompt || links.length <= 1) return links.slice(0, limit).map((l) => l.url);
  try {
    const picked = await engine.llm.selectLinks(links, req.prompt, limit, Deadline.unbounded(signal));
    if (picked.length) return picked.map((l) => l.url);
    warnings.push(
      `${base}*: no page looked relevant to the prompt, so the first ${Math.min(limit, links.length)} pages of the site map were used`,
    );
  } catch (err) {
    if (signal.aborted) throw err;
    log.warn("could not select the relevant pages of a /* URL; using the site map order", { error: toAppError(err).message });
    warnings.push(
      `${base}*: choosing relevant pages with the LLM failed (${toAppError(err).message}), so the first ${Math.min(limit, links.length)} pages of the site map were used`,
    );
  }
  return links.slice(0, limit).map((l) => l.url);
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
): Promise<{ result: unknown; used: string[]; itemSources: Record<string, string[]>; notes: string[] }> {
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
  const notes: string[] = [];
  const entityPieces: Array<{ url: string; value: unknown }> = [];
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
              entityPieces.push({ url: piece.url, value: v });
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
    // Chunks that answer a field differently: `mergeAll` keeps the first, and the caller should know.
    const conflicts = conflictingFields(found);
    if (conflicts.length) notes.push(`Pages gave different values for ${conflicts.join(", ")}; the first one was kept`);
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
  return {
    result,
    used: pages.map((p) => p.url).filter((u) => used.has(u)),
    itemSources: entitySources(result, entityPieces),
    notes,
  };
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
