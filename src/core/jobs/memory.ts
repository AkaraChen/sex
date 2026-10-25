import { randomUUID } from "node:crypto";
import pLimit from "p-limit";
import { log } from "../../log.ts";
import type { Document } from "../../schemas.ts";
import type { JobError, JobKind, JobPatch, JobRecord, JobStore, Task, TaskQueue } from "./types.ts";

interface Entry {
  record: JobRecord;
  docs: Document[];
  /** Approximate bytes held by `docs` (JSON length). */
  docBytes: number;
  errors: JobError[];
  robots: string[];
  robotsTxt: string;
  seen: Set<string>;
  /** taskIds whose `pending` decrement has been applied. */
  settled: Set<string>;
  /** Start time (ms) of the next free crawl politeness slot. */
  nextSlotAt: number;
}

/** Total document JSON kept in memory before the oldest finished jobs are evicted. */
export const MEMORY_DOC_BUDGET_BYTES = 512 * 1024 * 1024;

/** Single-process job state; jobs expire after `ttlMs` (config.jobTtlMs, default 24h) or when documents exceed `maxDocBytes`. */
export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Entry>();
  private readonly sweeper = setInterval(() => this.sweep(), 10 * 60 * 1000);

  private totalDocBytes = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxDocBytes = MEMORY_DOC_BUDGET_BYTES,
  ) {
    this.sweeper.unref?.();
  }

  private entry(id: string): Entry | undefined {
    return this.jobs.get(id);
  }

  async create(init: Pick<JobRecord, "kind" | "url" | "options">): Promise<JobRecord> {
    const now = Date.now();
    const record: JobRecord = {
      ...init,
      id: randomUUID(),
      status: "scraping",
      createdAt: now,
      expiresAt: now + this.ttlMs,
      total: 0,
      completed: 0,
      pending: 0,
      scheduled: 0,
      slots: 0,
    };
    this.jobs.set(record.id, {
      record,
      docs: [],
      docBytes: 0,
      errors: [],
      robots: [],
      robotsTxt: "",
      seen: new Set(),
      settled: new Set(),
      nextSlotAt: 0,
    });
    return { ...record };
  }

  async get(id: string) {
    const e = this.entry(id);
    return e ? { ...e.record } : undefined;
  }

  async patch(id: string, patch: JobPatch) {
    const e = this.entry(id);
    if (e) Object.assign(e.record, patch);
  }

  async finish(id: string, status: Exclude<JobRecord["status"], "scraping">, patch?: JobPatch) {
    const e = this.entry(id);
    if (e?.record.status !== "scraping") return false;
    Object.assign(e.record, patch, { status });
    return true;
  }

  async reopen(id: string) {
    const e = this.entry(id);
    if (e?.record.status === "completed") e.record.status = "scraping";
  }

  async incr(id: string, counter: keyof Pick<JobRecord, "total" | "completed" | "pending" | "scheduled" | "slots">, by = 1) {
    const e = this.entry(id);
    if (!e) return 0;
    e.record[counter] += by;
    return e.record[counter];
  }

  async settle(id: string, taskId: string | undefined, countCompleted = false) {
    const e = this.entry(id);
    if (!e) return null;
    if (taskId !== undefined) {
      if (e.settled.has(taskId)) return null;
      e.settled.add(taskId);
    }
    if (countCompleted) e.record.completed += 1;
    e.record.pending -= 1;
    return e.record.pending;
  }

  async reserveSlots(id: string, count: number, intervalMs: number, now: number) {
    const e = this.entry(id);
    if (!e) return now;
    const start = Math.max(now, e.nextSlotAt);
    e.nextSlotAt = start + count * intervalMs;
    return start;
  }

  async pushDocument(id: string, doc: Document) {
    const e = this.entry(id);
    if (!e) return;
    const bytes = JSON.stringify(doc).length;
    e.docs.push(doc);
    e.docBytes += bytes;
    this.totalDocBytes += bytes;
    this.evictOverBudget();
  }

  /** Drops the oldest finished jobs (Map order is creation order) until the stored documents fit the budget. */
  private evictOverBudget() {
    if (this.totalDocBytes <= this.maxDocBytes) return;
    for (const [id, e] of this.jobs) {
      if (this.totalDocBytes <= this.maxDocBytes) return;
      if (e.record.status === "scraping") continue;
      this.remove(id);
    }
  }

  private remove(id: string) {
    const e = this.jobs.get(id);
    if (!e) return;
    this.totalDocBytes -= e.docBytes;
    this.jobs.delete(id);
  }

  async documents(id: string, skip: number, maxChars: number) {
    const docs = this.entry(id)?.docs ?? [];
    const data: Document[] = [];
    let size = 0;
    let i = skip;
    for (; i < docs.length; i++) {
      const len = JSON.stringify(docs[i]).length;
      if (data.length > 0 && size + len > maxChars) break;
      data.push(docs[i] as Document);
      size += len;
    }
    return { data, nextSkip: i < docs.length ? i : null };
  }

  async pushError(id: string, error: JobError) {
    this.entry(id)?.errors.push(error);
  }

  async errors(id: string) {
    return [...(this.entry(id)?.errors ?? [])];
  }

  async setRobotsTxt(id: string, text: string) {
    const e = this.entry(id);
    if (e) e.robotsTxt = text;
  }

  async robotsTxt(id: string) {
    return this.entry(id)?.robotsTxt ?? "";
  }

  async pushRobotsBlocked(id: string, url: string) {
    this.entry(id)?.robots.push(url);
  }

  async robotsBlocked(id: string) {
    return [...(this.entry(id)?.robots ?? [])];
  }

  async markSeen(id: string, keys: string[]) {
    const seen = this.entry(id)?.seen;
    return keys.map((k) => {
      if (!seen || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  async active(kind: JobKind) {
    return [...this.jobs.values()].filter((e) => e.record.kind === kind && e.record.status === "scraping").map((e) => ({ ...e.record }));
  }

  async close() {
    clearInterval(this.sweeper);
  }

  private sweep() {
    const now = Date.now();
    for (const [id, e] of this.jobs) if (e.record.expiresAt < now) this.remove(id);
  }
}

const MAX_TIMER_MS = 2 ** 31 - 1;

/** In-process queue: tasks run on a p-limit pool; delayed tasks wait on a timer. */
export class MemoryTaskQueue implements TaskQueue {
  private handler?: (task: Task) => Promise<void>;
  private readonly buffered: Task[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly limit: ReturnType<typeof pLimit>;
  private closed = false;

  constructor(concurrency: number) {
    this.limit = pLimit(concurrency);
  }

  async add(tasks: Array<{ task: Task; delayMs?: number }>) {
    for (const { task, delayMs } of tasks) {
      if (delayMs && delayMs > 0) this.schedule(task, Date.now() + delayMs);
      else this.dispatch(task);
    }
  }

  /** Timers longer than 2^31-1 ms fire immediately, so long delays are re-armed in chunks. */
  private schedule(task: Task, dueAt: number) {
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        const left = dueAt - Date.now();
        if (left > 0) this.schedule(task, dueAt);
        else this.dispatch(task);
      },
      Math.min(Math.max(0, dueAt - Date.now()), MAX_TIMER_MS),
    );
    this.timers.add(timer);
  }

  startWorker(handler: (task: Task) => Promise<void>) {
    this.handler = handler;
    for (const task of this.buffered.splice(0)) this.dispatch(task);
  }

  private dispatch(task: Task) {
    if (this.closed) return;
    const handler = this.handler;
    if (!handler) {
      this.buffered.push(task);
      return;
    }
    this.limit(() => handler(task)).catch((err) =>
      log.error("task failed", {
        type: task.type,
        job: task.jobId,
        ...("url" in task ? { url: task.url } : {}),
        error: String(err),
      }),
    );
  }

  async close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.limit.clearQueue();
  }
}
