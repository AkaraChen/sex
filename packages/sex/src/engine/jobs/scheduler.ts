import type { Lane, QueuedTask, Task, TaskQueue } from "./types.ts";

/**
 * Who goes first, and how fast one job may go. The queue (`TaskQueue`) only carries out what is decided here, so the
 * policy lives in one place and a new kind of task gets its place by adding one case to `laneOf`.
 *
 * - Urgent tasks (crawl-start, extract) have no lane. The queue serves tasks without a lane before any lane's, so a
 *   crawl or an extract is not stuck behind pages already queued, however many.
 * - Page tasks wait in their job's lane. Lanes are served in turn, so a 10,000-URL batch leaves every other job its
 *   share of the workers, and one job's pages are never ahead of another's merely for being queued earlier.
 * - A job's lane is capped at its `maxConcurrency`. With `delay` the cap is 1 and the lane cools down for `delay`
 *   seconds after each page *finished*: the next page starts a delay after the previous one is done, never while it
 *   is running. Pacing is applied while the job runs, not reserved when pages are discovered, so slow pages cannot
 *   pile up behind slots that already passed.
 * - Nothing here ever re-queues a task. The queue skips a lane that is at its cap or cooling down; it does not take a
 *   task out, look at it and put it back. A task therefore has one taskId and one queue entry, and settling
 *   (`pending`), documents and failures stay exactly as `task_effects` and the outbox already guarantee for crash
 *   redelivery.
 *
 * Webhook retries (#46) come in as a third kind of task: a `webhook` case in `laneOf` that gives them a lane of their
 * own (`webhook:<jobId>`, so a slow receiver neither delays the job's pages nor takes more than its share of workers),
 * `delayMs` for the backoff, and a new `TaskEffect` for "attempt n delivered". A retry is a new task with its own
 * taskId, queued through `JobScheduler.add` like everything else, so it never shares a page's settlement.
 */
export interface PageLimits {
  /** Most pages of the job running at once; undefined = only the server-wide `SEX_CONCURRENCY`. */
  concurrency?: number;
  /** Quiet time after a page has finished. */
  cooldownMs: number;
}

/** What a job's request says about its pace: `delay` (seconds) forces one page at a time. */
export function pageLimits(options: Record<string, unknown>): PageLimits {
  const delay = typeof options.delay === "number" && options.delay > 0 ? options.delay : 0;
  const max = typeof options.maxConcurrency === "number" && options.maxConcurrency > 0 ? options.maxConcurrency : undefined;
  return delay > 0 ? { concurrency: 1, cooldownMs: Math.max(1, Math.round(delay * 1000)) } : { concurrency: max, cooldownMs: 0 };
}

/** The lane a task waits in; none for tasks that go ahead of every lane. */
function laneOf(task: Task, limits: PageLimits | undefined): Lane | undefined {
  switch (task.type) {
    case "crawl-start":
    case "extract":
      return undefined;
    case "page":
      return { id: task.jobId, cooldownMs: limits?.cooldownMs };
  }
}

export class JobScheduler {
  /** The cap last set for each job's lane in this process, so it is only written when it changes. */
  private readonly caps = new Map<string, number | undefined>();

  constructor(private readonly queue: TaskQueue) {}

  /** Queues tasks of one job. `options` is the job's request (or an appended batch's), which sets the pace of its page tasks. */
  async add(tasks: Array<{ task: Task; delayMs?: number }>, options: Record<string, unknown> = {}): Promise<void> {
    const limits = tasks.some((t) => t.task.type === "page") ? pageLimits(options) : undefined;
    // The cap is set before the first page is queued, so no page can start without it.
    for (const jobId of new Set(tasks.filter((t) => t.task.type === "page").map((t) => t.task.jobId))) {
      await this.cap(jobId, limits?.concurrency);
    }
    await this.queue.add(tasks.map((t): QueuedTask => ({ ...t, lane: laneOf(t.task, limits) })));
  }

  /** The job has no task left: forget its cap, also one stored before a restart. A later append to the job sets it again. */
  async release(jobId: string): Promise<void> {
    this.caps.delete(jobId);
    await this.queue.capLane(jobId, undefined);
  }

  private async cap(jobId: string, limit: number | undefined) {
    if (this.caps.has(jobId) && this.caps.get(jobId) === limit) return;
    this.caps.set(jobId, limit);
    await this.queue.capLane(jobId, limit);
  }
}
