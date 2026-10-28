import type { Document } from "../../schemas.ts";
import type { Engine } from "../engine.ts";
import { sendWebhook } from "./index.ts";
import type { JobRecord } from "./types.ts";

/**
 * The side effects of one task, each performed at most once however often the queue delivers the task. Handlers
 * create one per run and use it instead of calling the store and `sendWebhook` themselves, so the rule lives here:
 * a redelivered task (one that crashed before `settle`) repeats its work but not its stored results, its counts or
 * its webhooks. Without a taskId (tasks queued before ids existed) nothing is deduplicated.
 *
 * Effects follow their store write: an event is queued only when that write was new, so a crash between the write
 * and the event loses the event (webhooks are best effort) rather than sending it twice.
 */
export interface TaskEffects {
  /**
   * Stores the page's document and, when it was new, sends the `page` webhook. With `countCompleted` the page is
   * also added to `completed`, atomically with the document. Returns whether the document was new.
   */
  page(document: Document, opts?: { countCompleted?: boolean }): Promise<boolean>;
  /** Records that scraping `url` failed and, when that was new, sends the `page` webhook with `success: false`. */
  failure(url: string, message: string): Promise<void>;
  /** Sends the job's `started` webhook, unless an earlier delivery of this task did. */
  started(): Promise<void>;
}

export function taskEffects(engine: Engine, job: JobRecord, taskId: string | undefined): TaskEffects {
  const { store } = engine.jobs;
  return {
    async page(document, opts) {
      const fresh = await store.pushDocument(job.id, document, taskId, opts?.countCompleted);
      if (fresh) await sendWebhook(engine, job, "page", [document]);
      return fresh;
    },
    async failure(url, message) {
      const fresh = await store.pushError(
        job.id,
        { id: crypto.randomUUID(), timestamp: new Date().toISOString(), url, error: message },
        taskId,
      );
      if (fresh) await sendWebhook(engine, job, "page", [{ metadata: { sourceURL: url } }], message);
    },
    async started() {
      if (await store.claimEffect(job.id, taskId, "started")) await sendWebhook(engine, job, "started");
    },
  };
}
