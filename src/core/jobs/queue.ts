import { randomUUID } from "node:crypto";
import { Queue, shutdownManager, Worker } from "bunqueue/client";
import { log } from "../../log.ts";
import type { Task, TaskQueue } from "./types.ts";

/**
 * bunqueue's embedded broker is one per process and opens one database, so every queue in the process must pass the
 * same `dataPath`, and the broker may only be shut down after the last queue closes.
 */
let openQueues = 0;

/**
 * Tasks on bunqueue's embedded broker: SQLite at `dataPath` (tasks survive a restart and resume when the worker
 * starts again) or `:memory:`. `dataPath` is always passed explicitly; bunqueue would otherwise fall back to generic
 * env vars such as DATA_PATH or SQLITE_PATH. Each task runs once (`attempts: 1`): handlers record their own failures
 * on the job. A task that was running when the process died is redelivered after its lock expires; `settle(taskId)`
 * keeps that from being counted twice.
 */
export class BunqueueTaskQueue implements TaskQueue {
  private readonly queue: Queue<Task>;
  private worker?: Worker<Task>;
  private closed = false;

  /** A persistent queue keeps a fixed name so a restarted process finds its tasks; in memory each queue gets its own. */
  constructor(
    private readonly dataPath: string,
    private readonly concurrency: number,
    private readonly name = dataPath === ":memory:" ? `tasks-${randomUUID()}` : "tasks",
  ) {
    this.queue = new Queue<Task>(name, { embedded: true, dataPath });
    openQueues++;
  }

  async add(tasks: Array<{ task: Task; delayMs?: number }>) {
    if (this.closed || tasks.length === 0) return;
    await this.queue.addBulk(
      tasks.map(({ task, delayMs }) => ({
        name: task.type,
        data: task,
        opts: {
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
          ...(delayMs && delayMs > 0 ? { delay: Math.round(delayMs) } : {}),
        },
      })),
    );
  }

  startWorker(handler: (task: Task) => Promise<void>) {
    if (this.worker || this.closed) return;
    this.worker = new Worker<Task>(this.name, (job) => handler(job.data), {
      embedded: true,
      dataPath: this.dataPath,
      concurrency: this.concurrency,
    });
    this.worker.on("failed", (job, err) =>
      log.error("task failed", {
        type: job?.data?.type,
        job: job?.data?.jobId,
        ...(job?.data && "url" in job.data ? { url: job.data.url } : {}),
        error: String(err),
      }),
    );
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.worker?.close();
    await this.queue.close();
    if (--openQueues === 0) shutdownManager();
  }
}
