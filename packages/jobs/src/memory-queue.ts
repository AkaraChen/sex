import { log } from "./log.ts";
import type { Lane, QueuedTask, Task, TaskOutcome, TaskQueue } from "./types.ts";

export interface MemoryTaskQueueOptions {
  /** Tasks running at once over all lanes. Defaults to 4. */
  concurrency?: number;
}

interface Entry {
  lane?: Lane;
  task: Task;
  /** When the task may start (epoch ms). */
  readyAt: number;
}

/**
 * A `TaskQueue` that keeps its tasks in memory: they are gone when the process ends, and nothing is redelivered or abandoned.
 * For one-shot runs, tests, and servers that do not need jobs to survive a restart. It follows the same rules as the persistent
 * queue of the sex app (bunqueue):
 *
 * - tasks without a lane are served first, in order, before any lane's;
 * - lanes are served in turn, so a lane with thousands of tasks cannot push another lane's tasks to the back;
 * - a lane with a cap (`capLane`) never has more than that many tasks running, and one with a `cooldownMs` starts no task for
 *   that long after one of its tasks finished (unless the handler said "skipped");
 * - a task with `delayMs` does not start before then; it counts as waiting meanwhile;
 * - a handler that throws is logged, never retried.
 */
export class MemoryTaskQueue implements TaskQueue {
  private readonly concurrency: number;
  /** Tasks without a lane, in the order they were added. */
  private readonly urgent: Entry[] = [];
  /** Waiting tasks per lane. A lane exists only while it has some. */
  private readonly lanes = new Map<string, Entry[]>();
  /** The lanes in the order they arrived, and where the next turn starts: lanes are served round-robin, one task at a time. */
  private readonly order: string[] = [];
  private turn = 0;
  private readonly caps = new Map<string, number>();
  private readonly running = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();
  private active = 0;
  private readonly inFlight = new Set<Promise<void>>();
  private handler?: (task: Task) => Promise<TaskOutcome | void>;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(options: MemoryTaskQueueOptions = {}) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  }

  async add(tasks: QueuedTask[]): Promise<void> {
    if (this.closed || tasks.length === 0) return;
    const now = Date.now();
    for (const { task, delayMs, lane } of tasks) {
      const entry: Entry = { task, lane, readyAt: delayMs && delayMs > 0 ? now + delayMs : now };
      if (!lane) this.urgent.push(entry);
      else {
        const queue = this.lanes.get(lane.id);
        if (queue) queue.push(entry);
        else {
          this.lanes.set(lane.id, [entry]);
          this.order.push(lane.id);
        }
      }
    }
    this.pump();
  }

  async capLane(lane: string, limit: number | undefined): Promise<void> {
    if (this.closed) return;
    if (limit === undefined) this.caps.delete(lane);
    else this.caps.set(lane, Math.max(1, Math.floor(limit)));
    this.pump();
  }

  async counts(): Promise<{ active: number; waiting: number }> {
    let waiting = this.urgent.length;
    for (const queue of this.lanes.values()) waiting += queue.length;
    return { active: this.active, waiting };
  }

  startWorker(handler: (task: Task) => Promise<TaskOutcome | void>, _onAbandoned?: (task: Task) => Promise<void>): void {
    if (this.handler || this.closed) return;
    this.handler = handler;
    this.pump();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.urgent.length = 0;
    this.lanes.clear();
    this.order.length = 0;
    await Promise.all(this.inFlight);
  }

  /** Starts as many eligible tasks as there are free slots, then sleeps until the next one becomes eligible. */
  private pump(): void {
    clearTimeout(this.timer);
    if (this.closed || !this.handler) return;
    const now = Date.now();
    for (const [id, until] of this.cooldownUntil) if (until <= now && !this.lanes.has(id)) this.cooldownUntil.delete(id);
    while (this.active < this.concurrency) {
      const next = this.take();
      if (!next) break;
      this.run(next.entry, next.lane);
    }
    const wake = this.nextWake();
    if (wake !== undefined) this.timer = setTimeout(() => this.pump(), Math.max(1, wake - Date.now()));
  }

  /** The next task to start, removed from its queue: urgent ones first, then the first lane in turn that is not capped or cooling down. */
  private take(): { entry: Entry; lane?: Lane } | undefined {
    const now = Date.now();
    const at = this.urgent.findIndex((e) => e.readyAt <= now);
    if (at >= 0) return { entry: this.urgent.splice(at, 1)[0] as Entry };
    for (let i = 0; i < this.order.length; i++) {
      const at = (this.turn + i) % this.order.length;
      const id = this.order[at] as string;
      if (!this.laneOpen(id, now)) continue;
      const queue = this.lanes.get(id) as Entry[];
      const index = queue.findIndex((e) => e.readyAt <= now);
      if (index < 0) continue;
      const [entry] = queue.splice(index, 1) as [Entry];
      if (queue.length > 0) this.turn = at + 1;
      else {
        // The lane is gone; the lane after it now has its position.
        this.lanes.delete(id);
        this.order.splice(at, 1);
        this.turn = at;
      }
      return { entry, lane: entry.lane };
    }
    return undefined;
  }

  private laneOpen(id: string, now: number): boolean {
    const cap = this.caps.get(id);
    if (cap !== undefined && (this.running.get(id) ?? 0) >= cap) return false;
    return (this.cooldownUntil.get(id) ?? 0) <= now;
  }

  /** When something that waits next becomes eligible by time alone (a delay ends, a cooldown ends); undefined if nothing does. */
  private nextWake(): number | undefined {
    let wake: number | undefined;
    const consider = (at: number) => {
      wake = wake === undefined ? at : Math.min(wake, at);
    };
    const now = Date.now();
    for (const e of this.urgent) if (e.readyAt > now) consider(e.readyAt);
    for (const [id, queue] of this.lanes) {
      const cooling = this.cooldownUntil.get(id) ?? 0;
      for (const e of queue) consider(Math.max(e.readyAt, cooling));
    }
    return wake !== undefined && wake > now ? wake : undefined;
  }

  private run(entry: Entry, lane?: Lane): void {
    const { task } = entry;
    this.active++;
    if (lane) this.running.set(lane.id, (this.running.get(lane.id) ?? 0) + 1);
    const handler = this.handler as (task: Task) => Promise<TaskOutcome | void>;
    const done: Promise<void> = Promise.resolve()
      .then(() => handler(task))
      .catch((err: unknown) => {
        log.error("task failed", { type: task.type, job: task.jobId, error: String(err) });
      })
      .then((outcome) => {
        this.active--;
        if (lane) {
          const left = (this.running.get(lane.id) ?? 1) - 1;
          if (left > 0) this.running.set(lane.id, left);
          else this.running.delete(lane.id);
          if (lane.cooldownMs && outcome !== "skipped") this.cooldownUntil.set(lane.id, Date.now() + lane.cooldownMs);
        }
        this.inFlight.delete(done);
        this.pump();
      });
    this.inFlight.add(done);
  }
}
