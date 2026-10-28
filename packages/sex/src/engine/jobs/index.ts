import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Deadline } from "@sex/core/deadline.ts";
import { log } from "@sex/core/log.ts";
import { assertPublicUrl, parseHttpUrl, safeFetch } from "@sex/core/net.ts";
import type { Config } from "../../config.ts";
import type { WebhookConfig } from "../../schemas.ts";
import type { Engine } from "../engine.ts";
import { createDocumentLog } from "./documents.ts";
import { BunqueueTaskQueue } from "./queue.ts";
import { JobScheduler } from "./scheduler.ts";
import { SqliteJobStore } from "./sqlite.ts";
import type { JobRecord, JobStore, TaskQueue } from "./types.ts";

export { JobScheduler, pageLimits } from "./scheduler.ts";
export * from "./types.ts";

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

/** Fire-and-forget webhook delivery using Firecrawl's `<kind>.<event>` payloads. */
export function sendWebhook(
  config: Config,
  job: JobRecord,
  event: "started" | "page" | "completed" | "failed",
  data: unknown[] = [],
  error?: string,
): void {
  const hook = job.options.webhook as WebhookConfig | undefined;
  if (!hook) return;
  const cfg = typeof hook === "string" ? { url: hook } : hook;
  if ("events" in cfg && cfg.events && !cfg.events.includes(event)) return;
  const body = {
    success: event !== "failed",
    type: `${job.kind}.${event}`,
    id: job.id,
    data,
    metadata: "metadata" in cfg ? (cfg.metadata ?? {}) : {},
    ...(error ? { error } : {}),
  };
  safeFetch(cfg.url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...("headers" in cfg ? (cfg.headers ?? {}) : {}) },
    deadline: Deadline.start(10_000),
    allowPrivateNetwork: config.allowPrivateNetwork,
    userAgent: config.userAgent,
    maxBodyBytes: 1024 * 1024,
  }).catch((err) => log.warn("webhook delivery failed", { url: cfg.url, error: err instanceof Error ? err.message : String(err) }));
}

/**
 * Marks one task of a job done; whoever finishes the last task completes the job. Each taskId settles at most once,
 * so a redelivered task cannot complete the job early or be counted twice. `countCompleted` also adds the task's page
 * to `completed`, in the same step.
 */
export async function settleTask(engine: Engine, jobId: string, taskId?: string, countCompleted = false): Promise<void> {
  const left = await engine.jobs.store.settle(jobId, taskId, countCompleted);
  if (left === null || left > 0) return;
  await engine.jobs.scheduler.release(jobId);
  if (await engine.jobs.store.finish(jobId, "completed")) {
    const job = await engine.jobs.store.get(jobId);
    if (job) sendWebhook(engine.config, job, "completed");
  }
}

export const PAGE_BUDGET_CHARS = 10 * 1024 * 1024;
