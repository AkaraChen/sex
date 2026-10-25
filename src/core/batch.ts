import { badRequest, notFound, toAppError } from "../errors.ts";
import type { BatchScrapeRequest, ScrapeOptions } from "../schemas.ts";
import type { Engine } from "./engine.ts";
import { type JobRecord, sendWebhook, validateWebhook } from "./jobs/index.ts";
import { assertPublicUrl, parseHttpUrl } from "./net.ts";
import { assertScrapeCapabilities, scrapeUrl } from "./scrape.ts";

async function splitUrls(engine: Engine, urls: string[], ignoreInvalid: boolean) {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of urls) {
    try {
      const url = parseHttpUrl(raw.trim());
      await assertPublicUrl(url, engine.config.allowPrivateNetwork);
      valid.push(url.href);
    } catch (err) {
      if (!ignoreInvalid) throw err;
      invalid.push(raw);
    }
  }
  return { valid, invalid };
}

export async function startBatchScrape(engine: Engine, req: BatchScrapeRequest): Promise<{ job: JobRecord; invalidURLs?: string[] }> {
  const { urls, ignoreInvalidURLs, appendToId, webhook, ...rest } = req;
  assertScrapeCapabilities(engine, rest);
  await validateWebhook(engine, webhook);
  const { valid, invalid } = await splitUrls(engine, urls, !!ignoreInvalidURLs);
  if (!valid.length) throw badRequest("No valid URLs to scrape", { invalidURLs: invalid });

  const { store, queue } = engine.jobs;
  let job: JobRecord;
  let taskOptions: Record<string, unknown> | undefined;
  if (appendToId) {
    const existing = await store.get(appendToId);
    if (existing?.kind !== "batch_scrape") throw notFound(`Job ${appendToId} not found`);
    if (existing.status === "cancelled") throw badRequest(`Batch ${appendToId} was cancelled`);
    // Count the new pages before reopening: if the last in-flight page settles now, pending stays > 0
    // and the job is not completed; if it already completed, reopen moves it back to scraping.
    await store.incr(existing.id, "pending", valid.length);
    await store.reopen(appendToId);
    job = existing;
    taskOptions = { ...rest };
  } else {
    job = await store.create({ kind: "batch_scrape", options: { ...rest, webhook } as Record<string, unknown> });
    sendWebhook(engine.config, job, "started");
    await store.incr(job.id, "pending", valid.length);
  }
  await store.incr(job.id, "total", valid.length);
  try {
    await queue.add(
      valid.map((url) => ({
        task: { type: "page" as const, jobId: job.id, taskId: crypto.randomUUID(), url, depth: 0, options: taskOptions },
      })),
    );
  } catch (err) {
    await store.incr(job.id, "pending", -valid.length);
    throw err;
  }
  return { job, invalidURLs: ignoreInvalidURLs ? invalid : undefined };
}

export async function handleBatchPage(engine: Engine, job: JobRecord, url: string, taskOptions?: Record<string, unknown>) {
  const { store } = engine.jobs;
  const source = taskOptions ?? job.options;
  const { webhook: _webhook, maxConcurrency: _mc, ...options } = source as ScrapeOptions & Record<string, unknown>;
  try {
    const { document } = await scrapeUrl(engine, url, options);
    if ((await store.get(job.id))?.status !== "scraping") return;
    await store.pushDocument(job.id, document);
    sendWebhook(engine.config, job, "page", [document]);
  } catch (err) {
    await store.pushError(job.id, { id: crypto.randomUUID(), timestamp: new Date().toISOString(), url, error: toAppError(err).message });
  } finally {
    await store.incr(job.id, "completed", 1);
  }
}
