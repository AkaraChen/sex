import { randomUUID } from "node:crypto";
import { log } from "@searxng-js/sex-server/log";
import { Queue, shutdownManager, Worker } from "bunqueue/client";
import type { QueuedTask, Task, TaskOutcome, TaskQueue } from "./types.ts";

/**
 * bunqueue's embedded broker is one per process and opens one database, so every queue in the process must pass the
 * same `dataPath`, and the broker may only be shut down after the last queue closes.
 */
let openQueues = 0;

/**
 * How many times a task may be interrupted (the process died, or its lock ran out) before bunqueue gives up on it and
 * moves it to its dead-letter queue, from which `startWorker` hands it to `onAbandoned`. Startup recovery counts every interrupted delivery as an attempt and dead-letters
 * the task once `attempts` is reached, so `attempts: 1` meant a task running at SIGKILL was never redelivered. A task
 * that keeps killing the process stops after this many deliveries instead of looping.
 */
const MAX_DELIVERIES = 3;

/**
 * What a bunqueue job carries. Tasks queued before lanes existed hold the bare `Task`, which is read as such.
 * The cooldown rides along because the "completed" event, where it is applied, only has the job.
 */
type Envelope = { task: Task; cooldownMs?: number };
const unwrap = (data: Envelope | Task): Envelope => ("task" in data ? data : { task: data });

function logTaskFailure(task: Task | undefined, err: unknown) {
  log.error("task failed", {
    type: task?.type,
    job: task?.jobId,
    ...(task && "url" in task ? { url: task.url } : {}),
    error: String(err),
  });
}

/**
 * Tasks on bunqueue's embedded broker: SQLite at `dataPath` (tasks survive a restart and resume when the worker
 * starts again) or `:memory:`. `dataPath` is always passed explicitly; bunqueue would otherwise fall back to generic
 * env vars such as DATA_PATH or SQLITE_PATH. A handler that throws is not retried: handlers record their own failures
 * on the job, so the wrapper logs the error and the task is done. A task that was running when the process died is
 * moved back to waiting by bunqueue's startup recovery (at most `MAX_DELIVERIES` times) and delivered again;
 * `settle(taskId)` and the `task_effects` claims keep that from being counted twice.
 *
 * A lane is a bunqueue group. The broker serves tasks without a group first, then the groups in turn (a group is
 * skipped while it is at its cap or cooling down, without a worker slot being spent on it), so lanes need no
 * priorities. A cap is a stored per-group concurrency override, which applies only because the worker states a default
 * (`concurrency` of the whole worker); it is persisted with the queue. A cooldown is the broker's group rate limit,
 * set when the task has completed.
 */
export class BunqueueTaskQueue implements TaskQueue {
  private readonly queue: Queue<Envelope>;
  private worker?: Worker<Envelope | Task, TaskOutcome | void>;
  private abandoned?: Promise<void>;
  private closed = false;

  /** A persistent queue keeps a fixed name so a restarted process finds its tasks; in memory each queue gets its own. */
  constructor(
    private readonly dataPath: string,
    private readonly concurrency: number,
    private readonly name = dataPath === ":memory:" ? `tasks-${randomUUID()}` : "tasks",
  ) {
    this.queue = new Queue<Envelope>(name, { embedded: true, dataPath });
    openQueues++;
  }

  async add(tasks: QueuedTask[]) {
    if (this.closed || tasks.length === 0) return;
    await this.queue.addBulk(
      tasks.map(({ task, delayMs, lane }) => ({
        name: task.type,
        data: { task, ...(lane?.cooldownMs ? { cooldownMs: lane.cooldownMs } : {}) } satisfies Envelope,
        opts: {
          ...(lane ? { groupId: lane.id } : {}),
          attempts: MAX_DELIVERIES,
          // An interrupted task is redelivered at once, not after bunqueue's default exponential backoff.
          backoff: 0,
          // Written to queue.sqlite before add() resolves. bunqueue otherwise buffers new tasks for a few ms, and a
          // crash in that window loses them while the job store already counts them as pending.
          durable: true,
          removeOnComplete: true,
          removeOnFail: true,
          ...(delayMs && delayMs > 0 ? { delay: Math.round(delayMs) } : {}),
        },
      })),
    );
  }

  async capLane(lane: string, limit: number | undefined) {
    if (this.closed) return;
    if (limit === undefined) await this.queue.removeGroupConcurrency(lane);
    else await this.queue.setGroupConcurrency(lane, Math.max(1, Math.floor(limit)));
  }

  async counts() {
    if (this.closed) return { active: 0, waiting: 0 };
    const c = await this.queue.getJobCountsAsync();
    return { active: c.active, waiting: c.waiting + c.prioritized + c.delayed };
  }

  startWorker(handler: (task: Task) => Promise<TaskOutcome | void>, onAbandoned?: (task: Task) => Promise<void>) {
    if (this.worker || this.closed) return;
    // A throw would make bunqueue retry the task (`attempts` is for interruptions), so errors end here.
    const run = async (task: Task) => {
      try {
        return await handler(task);
      } catch (err) {
        logTaskFailure(task, err);
      }
    };
    const worker = new Worker<Envelope | Task, TaskOutcome | void>(this.name, (job) => run(unwrap(job.data).task), {
      embedded: true,
      dataPath: this.dataPath,
      concurrency: this.concurrency,
      // Without a default per group, the per-group caps set by capLane are not enforced.
      group: { concurrency: this.concurrency },
    });
    this.worker = worker;
    worker.on("completed", (job, outcome) => {
      const { cooldownMs } = unwrap(job.data);
      if (!cooldownMs || outcome === "skipped") return;
      worker.rateLimitGroup(job, cooldownMs).catch((err) => log.warn("lane cooldown failed", { error: String(err) }));
    });
    worker.on("failed", (job, err) => logTaskFailure(job ? unwrap(job.data).task : undefined, err));
    if (onAbandoned)
      this.abandoned = this.drainDeadLetters(onAbandoned).catch((err) =>
        log.error("dead-letter queue could not be read", { error: String(err) }),
      );
  }

  /**
   * Hands the tasks in bunqueue's dead-letter queue to `onAbandoned`, then removes them. bunqueue emits no event when
   * its startup recovery dead-letters a task (it writes the entry straight to storage), so the queue is read once when
   * the worker starts, after recovery. A task that stalls into the DLQ while the process runs stays there until the
   * next start. An entry is removed only after `onAbandoned` returned, so a failure there is retried at the next start.
   */
  private async drainDeadLetters(onAbandoned: (task: Task) => Promise<void>) {
    for (const entry of await this.queue.getDlqAsync()) {
      if (this.closed) return;
      const { task } = unwrap(entry.job.data);
      log.warn("task abandoned by the queue", { type: task.type, job: task.jobId, reason: entry.reason, error: entry.error });
      try {
        await onAbandoned(task);
        await this.queue.removeDlqJobAsync(String(entry.job.id));
      } catch (err) {
        logTaskFailure(task, err);
      }
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.abandoned;
    await this.worker?.close();
    await this.queue.close();
    if (--openQueues === 0) shutdownManager();
  }
}
