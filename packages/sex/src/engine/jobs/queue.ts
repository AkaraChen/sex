import { randomUUID } from "node:crypto";
import { log } from "@sex/core/log.ts";
import { Queue, shutdownManager, Worker } from "bunqueue/client";
import type { QueuedTask, Task, TaskOutcome, TaskQueue } from "./types.ts";

/**
 * bunqueue's embedded broker is one per process and opens one database, so every queue in the process must pass the
 * same `dataPath`, and the broker may only be shut down after the last queue closes.
 */
let openQueues = 0;

/**
 * What a bunqueue job carries. Tasks queued before lanes existed hold the bare `Task`, which is read as such.
 * The cooldown rides along because the "completed" event, where it is applied, only has the job.
 */
type Envelope = { task: Task; cooldownMs?: number };
const unwrap = (data: Envelope | Task): Envelope => ("task" in data ? data : { task: data });

/**
 * Tasks on bunqueue's embedded broker: SQLite at `dataPath` (tasks survive a restart and resume when the worker
 * starts again) or `:memory:`. `dataPath` is always passed explicitly; bunqueue would otherwise fall back to generic
 * env vars such as DATA_PATH or SQLITE_PATH. Each task runs once (`attempts: 1`): handlers record their own failures
 * on the job. A task that was running when the process died is redelivered after its lock expires; `settle(taskId)`
 * keeps that from being counted twice.
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
          attempts: 1,
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

  startWorker(handler: (task: Task) => Promise<TaskOutcome | void>) {
    if (this.worker || this.closed) return;
    const worker = new Worker<Envelope | Task, TaskOutcome | void>(this.name, async (job) => handler(unwrap(job.data).task), {
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
    worker.on("failed", (job, err) => {
      const { task } = job ? unwrap(job.data) : { task: undefined };
      log.error("task failed", {
        type: task?.type,
        job: task?.jobId,
        ...(task && "url" in task ? { url: task.url } : {}),
        error: String(err),
      });
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.worker?.close();
    await this.queue.close();
    if (--openQueues === 0) shutdownManager();
  }
}
