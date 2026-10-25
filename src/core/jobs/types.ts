import type { Document } from "../../schemas.ts";

export type JobKind = "crawl" | "batch_scrape" | "extract";
export type JobState = "scraping" | "completed" | "failed" | "cancelled";

export interface JobError {
  id: string;
  timestamp: string;
  url: string;
  error: string;
}

export interface JobMeta {
  id: string;
  kind: JobKind;
  status: JobState;
  /** Start URL (crawl). */
  url?: string;
  /** The validated request, as JSON. */
  options: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  error?: string;
  /** Extract result. */
  result?: unknown;
  sources?: Record<string, unknown>;
}

export interface JobCounters {
  /** URLs scheduled (crawl) or submitted (batch). */
  total: number;
  /** Pages finished (crawl: stored documents; batch: successes + failures). */
  completed: number;
  /** Tasks queued or running; the job completes when this drops to 0. */
  pending: number;
  /** Crawl: URLs accepted so far, checked against `limit`. */
  scheduled: number;
  /** Crawl: politeness-delay slots handed out. */
  slots: number;
}

export type CounterName = keyof JobCounters;
export type JobRecord = JobMeta & JobCounters;
export type JobPatch = Partial<Pick<JobMeta, "error" | "result" | "sources">>;

/** Where job state lives: process memory or Redis. All methods are safe to call from many workers. */
export interface JobStore {
  create(init: Pick<JobMeta, "kind" | "url" | "options">): Promise<JobRecord>;
  get(id: string): Promise<JobRecord | undefined>;
  patch(id: string, patch: JobPatch): Promise<void>;
  /** Moves a job out of "scraping"; returns false if it already left that state. */
  finish(id: string, status: Exclude<JobState, "scraping">, patch?: JobPatch): Promise<boolean>;
  /** Moves a completed job back to "scraping" (batch appendToId). */
  reopen(id: string): Promise<void>;
  incr(id: string, counter: CounterName, by?: number): Promise<number>;
  /** Decrements `pending` once for this task; returns the new value, or null if `taskId` was already settled. With `countCompleted` the same step also increments `completed`, so a redelivered task is not counted twice. Without a taskId it behaves like `incr(id, "pending", -1)`. */
  settle(id: string, taskId: string | undefined, countCompleted?: boolean): Promise<number | null>;
  /** Reserves `count` fetch slots spaced `intervalMs` apart, starting no earlier than `now` or the end of the previous reservation. Returns the start time (ms) of the first slot. */
  reserveSlots(id: string, count: number, intervalMs: number, now: number): Promise<number>;
  pushDocument(id: string, doc: Document): Promise<void>;
  /** Documents from `skip`, up to ~maxChars of JSON; nextSkip is null when there are no more. */
  documents(id: string, skip: number, maxChars: number): Promise<{ data: Document[]; nextSkip: number | null }>;
  pushError(id: string, error: JobError): Promise<void>;
  errors(id: string): Promise<JobError[]>;
  /** Stores the robots.txt body fetched once per crawl and shared by all workers ("" = none). Kept out of the job record so status reads stay small. */
  setRobotsTxt(id: string, text: string): Promise<void>;
  /** The crawl's robots.txt body, or "" if none was stored. */
  robotsTxt(id: string): Promise<string>;
  pushRobotsBlocked(id: string, url: string): Promise<void>;
  robotsBlocked(id: string): Promise<string[]>;
  /** Adds keys to the job's seen-set; returns true for each key that was new. */
  markSeen(id: string, keys: string[]): Promise<boolean[]>;
  active(kind: JobKind): Promise<JobRecord[]>;
  close(): Promise<void>;
}

export type Task =
  | { type: "crawl-start"; jobId: string; taskId?: string }
  | { type: "page"; jobId: string; taskId?: string; url: string; depth: number; options?: Record<string, unknown> }
  | { type: "extract"; jobId: string };

export interface TaskQueue {
  add(tasks: Array<{ task: Task; delayMs?: number }>): Promise<void>;
  /** Starts consuming tasks in this process. */
  startWorker(handler: (task: Task) => Promise<void>): void;
  close(): Promise<void>;
}
