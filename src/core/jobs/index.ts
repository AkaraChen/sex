import type { Config } from "../../config.ts";
import { log } from "../../log.ts";
import type { WebhookConfig } from "../../schemas.ts";
import type { Engine } from "../engine.ts";
import { assertPublicUrl, parseHttpUrl, safeFetch } from "../net.ts";
import { MemoryJobStore, MemoryTaskQueue } from "./memory.ts";
import { BullTaskQueue, RedisJobStore, redisConnection } from "./redis.ts";
import type { JobRecord, JobStore, TaskQueue } from "./types.ts";

export * from "./types.ts";

export interface JobBackend {
  kind: "memory" | "redis";
  store: JobStore;
  queue: TaskQueue;
  close(): Promise<void>;
}

/** Redis + BullMQ when a Redis URL is configured, otherwise an in-process store and queue. */
export function createJobBackend(config: Config): JobBackend {
  if (config.redisUrl) {
    const url = config.redisUrl;
    const conn = redisConnection(url);
    const store = new RedisJobStore(conn, config.redisPrefix, config.jobTtlMs);
    const queue = new BullTaskQueue(conn, config.redisPrefix, config.concurrency, () => redisConnection(url, { blocking: true }));
    return {
      kind: "redis",
      store,
      queue,
      async close() {
        await queue.close();
        await store.close();
        conn.disconnect();
      },
    };
  }
  const store = new MemoryJobStore(config.jobTtlMs);
  const queue = new MemoryTaskQueue(config.concurrency);
  return {
    kind: "memory",
    store,
    queue,
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
    timeout: 10_000,
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
  if (await engine.jobs.store.finish(jobId, "completed")) {
    const job = await engine.jobs.store.get(jobId);
    if (job) sendWebhook(engine.config, job, "completed");
  }
}

export const PAGE_BUDGET_CHARS = 10 * 1024 * 1024;
