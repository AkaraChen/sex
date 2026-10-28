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
  /** Extract: what the pages' scrapes warned about, which the result alone does not show. */
  warning?: string;
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
}

export type CounterName = keyof JobCounters;

/**
 * A side effect a task performs at most once per job, however often the queue delivers the task. The store keeps one
 * record per (job, taskId, effect); `claimEffect`, `settle`, `pushDocument` and `pushError` each claim their effect
 * in the same transaction as the write they guard. New effects (e.g. a webhook delivery task) are added here.
 */
export type TaskEffect =
  /** `pending` decremented (see `settle`). */
  | "settle"
  /** The task's document was indexed (see `pushDocument`). */
  | "document"
  /** The task's failure was recorded (see `pushError`). */
  | "error"
  /** The crawl's `started` webhook went out. */
  | "started"
  /** The task marked its page's redirect target seen (see `claimSeen`). */
  | "redirect";
export type JobRecord = JobMeta & JobCounters;
export type JobPatch = Partial<Pick<JobMeta, "error" | "warning" | "result" | "sources">>;

/** Where job state lives (SQLite, see sqlite.ts). Methods are called concurrently by tasks, so each must be atomic on its own. */
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
  /**
   * Claims `effect` for this task: true the first time, false if the task already claimed it (a redelivery) or the job
   * is gone. Without a taskId nothing can be deduplicated, so it is true for any job that exists. The claim is not
   * undone if the caller crashes before performing the effect, so it suits effects that must not repeat more than
   * ones that must not be lost (webhooks); effects that are writes to the store use their own method instead.
   */
  claimEffect(id: string, taskId: string | undefined, effect: TaskEffect): Promise<boolean>;
  /**
   * Stores a document, once per task: returns true if this call stored it, false if the task's document was already
   * stored (a redelivery) or the job is gone. Callers act on a new document only when this is true (page webhook).
   * With `countCompleted`, the same transaction that indexes the document also increments `completed`. Without a
   * taskId every call stores a new document.
   */
  pushDocument(id: string, doc: Document, taskId?: string, countCompleted?: boolean): Promise<boolean>;
  /** Documents from `skip`, up to ~maxChars of JSON; nextSkip is null when there are no more. */
  documents(id: string, skip: number, maxChars: number): Promise<{ data: Document[]; nextSkip: number | null }>;
  /** The same page as `documents`, each document as its JSON text (UTF-8), so it can be sent without parsing it first. */
  documentsJson(id: string, skip: number, maxChars: number): Promise<{ data: Uint8Array[]; nextSkip: number | null }>;
  /** Records a failure, once per task when a taskId is given (a redelivered task does not list it twice). */
  pushError(id: string, error: JobError, taskId?: string): Promise<void>;
  errors(id: string): Promise<JobError[]>;
  /** Stores the robots.txt body fetched once per crawl and shared by all workers ("" = none). Kept out of the job record so status reads stay small. */
  setRobotsTxt(id: string, text: string): Promise<void>;
  /** The crawl's robots.txt body, or "" if none was stored. */
  robotsTxt(id: string): Promise<string>;
  pushRobotsBlocked(id: string, url: string): Promise<void>;
  robotsBlocked(id: string): Promise<string[]>;
  /**
   * Marks one key seen on behalf of a task: true if it was new, or if this same task is the one that marked it (a
   * redelivery after a crash, which must carry on with the page rather than find its own mark and drop it). The mark
   * and the task's claim on it are one transaction. Without a taskId it only reports whether the key was new.
   */
  claimSeen(id: string, taskId: string | undefined, key: string): Promise<boolean>;
  /**
   * Crawl discovery as one atomic step, so a crash cannot mark a URL seen without leaving a page task for it. Each
   * candidate whose key is new is marked seen; a `blocked` one goes to the robots list, the others take a slot under
   * `limit` (past it they are seen but not crawled). Every slot counts `scheduled`, `total` and `pending` and becomes
   * a row of the job's outbox, owned by `owner` (the discovering task), with its page task's taskId. Pacing (a
   * politeness delay, a concurrency cap) is not decided here: the scheduler applies it when the rows are queued.
   * Returns the new outbox rows; the caller queues them, then calls `released`.
   */
  schedule(id: string, owner: string | undefined, candidates: LinkCandidate[], opts: ScheduleOptions): Promise<OutboxTask[]>;
  /** The outbox rows `owner` left behind: tasks it scheduled but may not have queued before it crashed. */
  outbox(id: string, owner: string): Promise<OutboxTask[]>;
  /**
   * Removes outbox rows once their tasks are queued. With `queued: false` (the queue refused them) their `pending`
   * counts are given back too, since nothing will run or settle those tasks. Rows already removed count for nothing.
   */
  released(id: string, taskIds: string[], queued: boolean): Promise<void>;
  active(kind: JobKind): Promise<JobRecord[]>;
  close(): Promise<void>;
}

/** A crawl link after filtering: `key` is its deduplication key, `blocked` means robots.txt forbids it. */
export interface LinkCandidate {
  key: string;
  url: string;
  blocked: boolean;
}

export interface ScheduleOptions {
  limit: number;
  depth: number;
}

/** A page task scheduled by `schedule` and not yet confirmed queued. */
export interface OutboxTask {
  taskId: string;
  url: string;
  depth: number;
}

export type Task =
  | { type: "crawl-start"; jobId: string; taskId?: string }
  | { type: "page"; jobId: string; taskId?: string; url: string; depth: number; options?: Record<string, unknown> }
  | { type: "extract"; jobId: string };

/** A task and how the queue should hold it. Decided by the `JobScheduler`; the queue only carries it out. */
export interface QueuedTask {
  task: Task;
  /** Not run before this many ms from now. */
  delayMs?: number;
  /**
   * Where the task waits. Without a lane it goes ahead of every lane's tasks (the queue serves tasks outside any lane
   * first); tasks of one lane share its cap (`TaskQueue.capLane`) and are served in turn with the other lanes, so a
   * lane with thousands of tasks cannot push another lane's tasks to the back.
   */
  lane?: Lane;
}

export interface Lane {
  id: string;
  /** After one of the lane's tasks has run, the lane starts no other task for this long. */
  cooldownMs?: number;
}

/**
 * What a handler reports. A "skipped" task did no work (its job was cancelled or finished), so it does not start its
 * lane's cooldown: draining a cancelled job's pages must not take `delay` seconds each.
 */
export type TaskOutcome = "done" | "skipped";

export interface TaskQueue {
  add(tasks: QueuedTask[]): Promise<void>;
  /** At most `limit` tasks of the lane run at once (no limit when undefined). Outlives a restart together with the queued tasks. */
  capLane(lane: string, limit: number | undefined): Promise<void>;
  /** Starts consuming tasks in this process. */
  startWorker(handler: (task: Task) => Promise<TaskOutcome | void>): void;
  close(): Promise<void>;
}
