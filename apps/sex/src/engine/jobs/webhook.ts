import { createHmac } from "node:crypto";
import { log } from "@searxng-js/sex-server/log";
import { Deadline } from "../../deadline.ts";
import { fetchWithin } from "../../fetch-within.ts";
import { WEBHOOK_SIGNATURE_HEADER, type WebhookConfig } from "../../schemas.ts";
import type { Engine } from "../engine.ts";
import type { JobRecord, Task, WebhookPayload } from "./types.ts";

type WebhookTask = Extract<Task, { type: "webhook" }>;
export type WebhookEvent = "started" | "page" | "completed" | "failed";

/** Delivery attempts per webhook (the first one included). */
export const WEBHOOK_MAX_ATTEMPTS = 5;
/** Wait before the second attempt; it doubles with every further one (5 s, 10 s, 20 s, 40 s). */
export const WEBHOOK_RETRY_BASE_MS = 5_000;
const ATTEMPT_TIMEOUT_MS = 10_000;

/** `sha256=<hex>` of the HMAC-SHA256 of `body` under `secret`: the value of the signature header. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const webhookOf = (job: JobRecord) => {
  const hook = job.options.webhook as WebhookConfig | undefined;
  return typeof hook === "string" ? { url: hook } : hook;
};

/**
 * Queues the delivery of a webhook event using Firecrawl's `<kind>.<event>` payloads; nothing is sent from here. The
 * attempts are tasks (`deliverWebhook`), so they survive a restart and retry with backoff. Never throws: a webhook
 * that cannot be queued is logged and dropped, because a job does not depend on its receiver.
 */
export async function sendWebhook(
  engine: Engine,
  job: JobRecord,
  event: WebhookEvent,
  data: unknown[] = [],
  error?: string,
): Promise<void> {
  const hook = webhookOf(job);
  if (!hook || (hook.events && !hook.events.includes(event))) return;
  const payload: WebhookPayload = {
    success: error === undefined,
    type: `${job.kind}.${event}`,
    id: job.id,
    webhookId: crypto.randomUUID(),
    data,
    metadata: hook.metadata ?? {},
    ...(error === undefined ? {} : { error }),
  };
  try {
    await engine.jobs.scheduler.add([{ task: { type: "webhook", jobId: job.id, taskId: crypto.randomUUID(), attempt: 1, payload } }]);
  } catch (err) {
    log.warn("webhook could not be queued", { url: hook.url, error: String(err) });
  }
}

/**
 * One delivery attempt. Claimed per taskId, so a task the queue delivers twice POSTs once (a crash between the claim
 * and the POST loses that attempt, as for every webhook). A failed attempt queues the next one as a new task after the
 * backoff, until `WEBHOOK_MAX_ATTEMPTS`; the body, `webhookId` included, is the same each time.
 */
export async function deliverWebhook(engine: Engine, task: WebhookTask): Promise<void> {
  const { store, scheduler } = engine.jobs;
  const job = await store.get(task.jobId);
  const hook = job && webhookOf(job);
  if (!hook || !(await store.claimEffect(task.jobId, task.taskId, "webhook"))) return;

  const body = JSON.stringify(task.payload);
  const { webhookSecret } = engine.config;
  let failure: { message: string; retry: boolean };
  try {
    const res = await fetchWithin(hook.url, Deadline.start(ATTEMPT_TIMEOUT_MS), {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        ...hook.headers,
        ...(webhookSecret ? { [WEBHOOK_SIGNATURE_HEADER]: signBody(webhookSecret, body) } : {}),
      },
      allowPrivateNetwork: engine.config.allowPrivateNetwork,
      proxy: engine.config.proxyUrl,
      userAgent: engine.config.userAgent,
      maxBodyBytes: 1024 * 1024,
    });
    if (res.status >= 200 && res.status < 300) return;
    // The receiver answered: another 4xx will not change by asking again, a 5xx, 408 or 429 may.
    failure = { message: `HTTP ${res.status}`, retry: res.status >= 500 || res.status === 408 || res.status === 429 };
  } catch (err) {
    failure = { message: err instanceof Error ? err.message : String(err), retry: true };
  }

  const context = { url: hook.url, job: task.jobId, event: task.payload.type, attempt: task.attempt, error: failure.message };
  if (!failure.retry || task.attempt >= WEBHOOK_MAX_ATTEMPTS) {
    log.warn("webhook delivery failed", context);
    return;
  }
  log.debug("webhook delivery failed, retrying", context);
  await scheduler.add([
    {
      task: { ...task, taskId: crypto.randomUUID(), attempt: task.attempt + 1 },
      delayMs: WEBHOOK_RETRY_BASE_MS * 2 ** (task.attempt - 1),
    },
  ]);
}
