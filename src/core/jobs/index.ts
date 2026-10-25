import type { Config } from "../../config.ts";
import { log } from "../../log.ts";
import type { WebhookConfig } from "../../schemas.ts";
import type { Engine } from "../engine.ts";
import { assertPublicUrl, parseHttpUrl } from "../net.ts";
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
    const conn = redisConnection(config.redisUrl);
    const store = new RedisJobStore(conn, config.redisPrefix, config.jobTtlMs);
    const queue = new BullTaskQueue(conn, config.redisPrefix, config.concurrency);
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
  fetch(cfg.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...("headers" in cfg ? (cfg.headers ?? {}) : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => log.warn("webhook delivery failed", { url: cfg.url, error: err instanceof Error ? err.message : String(err) }));
}

/** Marks one task of a job done; whoever finishes the last task completes the job. */
export async function settleTask(store: JobStore, jobId: string): Promise<void> {
  const left = await store.incr(jobId, "pending", -1);
  if (left > 0) return;
  if (await store.finish(jobId, "completed")) {
    const job = await store.get(jobId);
    if (job) sendWebhook(job, "completed");
  }
}

export const PAGE_BUDGET_CHARS = 10 * 1024 * 1024;
