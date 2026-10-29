import { assertPublicUrl, parseHttpUrl } from "@searxng-js/sex-egress";
import { badRequest, notFound, toAppError } from "@searxng-js/sex-errors";
import { assertScrapeCapabilities, scrapeUrl } from "@sex/core/scrape.ts";
import type { BatchScrapeRequest, ScrapeOptions } from "../schemas.ts";
import type { Engine } from "./engine.ts";
import { taskEffects } from "./jobs/effects.ts";
import { type JobRecord, sendWebhook, validateWebhook } from "./jobs/index.ts";

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
  const { valid, invalid } = await splitUrls(engine, urls, ignoreInvalidURLs ?? true);
  if (!valid.length) throw badRequest("No valid URLs to scrape", { invalidURLs: invalid });

  const { store, scheduler } = engine.jobs;
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
    await sendWebhook(engine, job, "started");
    await store.incr(job.id, "pending", valid.length);
  }
  await store.incr(job.id, "total", valid.length);
  try {
    await scheduler.add(
      valid.map((url) => ({
        task: { type: "page" as const, jobId: job.id, taskId: crypto.randomUUID(), url, depth: 0, options: taskOptions },
      })),
      taskOptions ?? job.options,
    );
  } catch (err) {
    // Nothing will run or settle these tasks: undo the counts, and if nothing else is in flight finish the job
    // (an appended batch goes back to completed, a new one fails) instead of leaving it "scraping" until the TTL.
    await store.incr(job.id, "total", -valid.length);
    const left = await store.incr(job.id, "pending", -valid.length);
    if (left <= 0) {
      if (appendToId) {
        if (await store.finish(job.id, "completed")) await sendWebhook(engine, job, "completed");
      } else if (await store.finish(job.id, "failed", { error: toAppError(err).message })) {
        await sendWebhook(engine, job, "failed", [], toAppError(err).message);
      }
    }
    throw err;
  }
  return { job, invalidURLs: invalid.length ? invalid : undefined };
}

/** Scrapes one batch page. A page that was stored counts in `completed`, one that failed leaves `total` (both once per task, see `TaskEffects`). */
export async function handleBatchPage(engine: Engine, job: JobRecord, url: string, taskOptions?: Record<string, unknown>, taskId?: string) {
  const { store } = engine.jobs;
  const fx = taskEffects(engine, job, taskId);
  const source = taskOptions ?? job.options;
  const { webhook: _webhook, maxConcurrency: _mc, ...options } = source as ScrapeOptions & Record<string, unknown>;
  try {
    const { document } = await scrapeUrl(engine, url, options);
    if ((await store.get(job.id))?.status !== "scraping") return;
    await fx.page(document);
  } catch (err) {
    const e = toAppError(err);
    await fx.failure(url, e.message, e.code);
  }
}
