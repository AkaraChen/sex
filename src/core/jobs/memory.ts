import { randomUUID } from "node:crypto";
import pLimit from "p-limit";
import { log } from "../../log.ts";
import type { Document } from "../../schemas.ts";
import {
  JOB_TTL_MS,
  type JobError,
  type JobKind,
  type JobPatch,
  type JobRecord,
  type JobStore,
  type Task,
  type TaskQueue,
} from "./types.ts";

interface Entry {
  record: JobRecord;
  docs: Document[];
  errors: JobError[];
  robots: string[];
  seen: Set<string>;
}

/** Single-process job state; jobs expire after SEX_JOB_TTL_MS (24h). */
export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Entry>();
  private readonly sweeper = setInterval(() => this.sweep(), 10 * 60 * 1000);

  constructor() {
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
      expiresAt: now + JOB_TTL_MS,
      total: 0,
      completed: 0,
      pending: 0,
      scheduled: 0,
      slots: 0,
    };
    this.jobs.set(record.id, { record, docs: [], errors: [], robots: [], seen: new Set() });
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

  async pushDocument(id: string, doc: Document) {
    this.entry(id)?.docs.push(doc);
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
    for (const [id, e] of this.jobs) if (e.record.expiresAt < now) this.jobs.delete(id);
  }
}

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
      if (delayMs && delayMs > 0) {
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          this.dispatch(task);
        }, delayMs);
        this.timers.add(timer);
      } else this.dispatch(task);
    }
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
    this.limit(() => handler(task)).catch((err) => log.error("task failed", { type: task.type, error: String(err) }));
  }

  async close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.limit.clearQueue();
  }
}
