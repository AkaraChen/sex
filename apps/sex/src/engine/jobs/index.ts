import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertPublicUrl, parseHttpUrl } from "@searxng-js/sex-egress";
import type { Config } from "../../config.ts";
import type { WebhookConfig } from "../../schemas.ts";
import type { Engine } from "../engine.ts";
import { createDocumentLog } from "./documents.ts";
import { BunqueueTaskQueue } from "./queue.ts";
import { JobScheduler } from "./scheduler.ts";
import { SqliteJobStore } from "./sqlite.ts";
import type { JobStore, TaskQueue } from "./types.ts";
import { sendWebhook } from "./webhook.ts";

export { JobScheduler, pageLimits } from "./scheduler.ts";
export * from "./types.ts";
export { sendWebhook } from "./webhook.ts";

export interface JobBackend {
  store: JobStore;
  queue: TaskQueue;
  /** Every task goes into the queue through this (order, pace), never directly. */
  scheduler: JobScheduler;
  close(): Promise<void>;
}

/**
 * Job state and tasks in SQLite files under `config.dataDir` (they survive a restart), or in memory without one.
 * Scraped documents go to the DocumentLog that `createDocumentLog` picks: `config.documentsUrl`, else JSONL files
 * under `<dataDir>/documents`, else memory.
 */
export function createJobBackend(config: Config): JobBackend {
  if (config.dataDir) mkdirSync(config.dataDir, { recursive: true });
  const path = (file: string) => (config.dataDir ? join(config.dataDir, file) : ":memory:");
  const store = new SqliteJobStore(path("jobs.sqlite"), config.jobTtlMs, createDocumentLog(config));
  const queue = new BunqueueTaskQueue(path("queue.sqlite"), config.concurrency);
  return {
    store,
    queue,
    scheduler: new JobScheduler(queue),
    async close() {
      await queue.close();
      await store.close();
    },
  };
}

export async function validateWebhook(engine: Engine, webhook: WebhookConfig | undefined): Promise<void> {
  if (!webhook) return;
  const url = parseHttpUrl(typeof webhook === "string" ? webhook : webhook.url);
  await assertPublicUrl(url, engine.config.allowPrivateNetwork);
}

/**
 * Marks one task of a job done; whoever finishes the last task completes the job. Each taskId settles at most once,
 * so a redelivered task cannot complete the job early or be counted twice. (`completed` is not counted here: a page
 * is counted when its document is stored, see `TaskEffects.page`.)
 */
export async function settleTask(engine: Engine, jobId: string, taskId?: string): Promise<void> {
  const left = await engine.jobs.store.settle(jobId, taskId);
  if (left === null || left > 0) return;
  await engine.jobs.scheduler.release(jobId);
  if (await engine.jobs.store.finish(jobId, "completed")) {
    const job = await engine.jobs.store.get(jobId);
    if (job) await sendWebhook(engine, job, "completed");
  }
}

export const PAGE_BUDGET_CHARS = 10 * 1024 * 1024;
