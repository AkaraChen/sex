import pLimit from "p-limit";
import { badRequest, toAppError } from "../errors.ts";
import { log } from "../log.ts";
import type { ExtractRequest } from "../schemas.ts";
import type { Engine } from "./engine.ts";
import type { JobRecord } from "./jobs/index.ts";
import { mapSite } from "./map.ts";
import { assertPublicUrl, parseHttpUrl } from "./net.ts";
import { assertScrapeCapabilities, scrapeUrl } from "./scrape.ts";
import { search } from "./search.ts";

const SEARCH_RESULTS = 5;

export async function startExtract(engine: Engine, req: ExtractRequest): Promise<{ job: JobRecord; invalidURLs?: string[] }> {
  engine.llm.require("Extract");
  if (!req.urls?.length && !(req.enableWebSearch && req.prompt)) {
    throw badRequest("Provide urls, or a prompt with enableWebSearch: true");
  }
  if (!req.prompt && !req.schema) throw badRequest("Provide a prompt and/or a schema");
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
    const { result, sources, total, completed } = await runExtract(engine, job.id, req, req.urls ?? [], controller.signal);
    if (controller.signal.aborted) return;
    await store.incr(job.id, "total", total);
    await store.incr(job.id, "completed", completed);
    await store.finish(job.id, "completed", { result, sources });
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
  const pages = await Promise.all(
    [...targets].map((url) =>
      limit(async () => {
        try {
          const { document } = await scrapeUrl(engine, url, options, { signal });
          return { url, markdown: document.markdown ?? "" };
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
  const ok = pages.filter((p): p is { url: string; markdown: string } => !!p && p.markdown.trim().length > 0);
  if (!ok.length) throw new Error(`Could not scrape any of the ${targets.size} source pages`);

  // Pack pages into LLM-sized chunks; merge partial results when there is more than one.
  const budget = engine.llm.maxInputChars;
  const chunks: string[] = [];
  let current = "";
  for (const p of ok) {
    const block = `## Source: ${p.url}\n\n${p.markdown.slice(0, budget)}\n\n`;
    if (current && current.length + block.length > budget) {
      chunks.push(current);
      current = "";
    }
    current += block;
  }
  if (current) chunks.push(current);

  const llmOpts = { prompt: req.prompt, schema: req.schema, systemPrompt: req.systemPrompt };
  const partials = await Promise.all(chunks.map((c) => limit(() => engine.llm.extractJson(c, llmOpts, signal))));
  const result =
    partials.length === 1
      ? partials[0]
      : await engine.llm.extractJson(
          `Partial extraction results from different source pages, as JSON:\n${JSON.stringify(partials)}`,
          {
            ...llmOpts,
            prompt: `Merge these partial results into one complete answer, deduplicating entries.${req.prompt ? ` Original instructions: ${req.prompt}` : ""}`,
          },
          signal,
        );

  return {
    result,
    sources: req.showSources ? { "*": ok.map((p) => p.url) } : undefined,
    total: targets.size,
    completed: ok.length,
  };
}
