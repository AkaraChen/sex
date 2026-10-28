import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { log } from "@sex/core/log.ts";
import pLimit from "p-limit";
import type { Document } from "../../schemas.ts";
import { type DocumentLog, READ_CONCURRENCY } from "./documents.ts";
import type {
  CounterName,
  JobError,
  JobKind,
  JobPatch,
  JobRecord,
  JobState,
  JobStore,
  LinkCandidate,
  OutboxTask,
  ScheduleOptions,
  TaskEffect,
} from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  url TEXT,
  options TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  error TEXT,
  warning TEXT,
  result TEXT,
  sources TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  scheduled INTEGER NOT NULL DEFAULT 0,
  robots_txt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS jobs_active ON jobs (kind, status);
CREATE INDEX IF NOT EXISTS jobs_expiry ON jobs (expires_at);
CREATE TABLE IF NOT EXISTS documents (
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  object TEXT NOT NULL,
  offset INTEGER NOT NULL,
  length INTEGER NOT NULL,
  chars INTEGER NOT NULL,
  PRIMARY KEY (job_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS dropped_jobs (
  job_id TEXT PRIMARY KEY
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS job_errors (
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_errors_job ON job_errors (job_id);
CREATE TABLE IF NOT EXISTS robots_blocked (
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  url TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS robots_blocked_job ON robots_blocked (job_id);
CREATE TABLE IF NOT EXISTS seen (
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  PRIMARY KEY (job_id, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS outbox (
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  owner TEXT,
  url TEXT NOT NULL,
  depth INTEGER NOT NULL,
  PRIMARY KEY (job_id, task_id)
);
CREATE INDEX IF NOT EXISTS outbox_owner ON outbox (job_id, owner);
CREATE TABLE IF NOT EXISTS task_effects (
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  effect TEXT NOT NULL,
  PRIMARY KEY (job_id, task_id, effect)
) WITHOUT ROWID;
`;

interface JobRow {
  id: string;
  kind: JobKind;
  status: JobState;
  url: string | null;
  options: string;
  created_at: number;
  expires_at: number;
  error: string | null;
  warning: string | null;
  result: string | null;
  sources: string | null;
  total: number;
  completed: number;
  pending: number;
  scheduled: number;
}

const COUNTERS = new Set<CounterName>(["total", "completed", "pending", "scheduled"]);

function toRecord(r: JobRow): JobRecord {
  const rec: JobRecord = {
    id: r.id,
    kind: r.kind,
    status: r.status,
    options: JSON.parse(r.options),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    total: r.total,
    completed: r.completed,
    pending: r.pending,
    scheduled: r.scheduled,
  };
  if (r.url !== null) rec.url = r.url;
  if (r.error !== null) rec.error = r.error;
  if (r.warning !== null) rec.warning = r.warning;
  if (r.result !== null) rec.result = JSON.parse(r.result);
  if (r.sources !== null) rec.sources = JSON.parse(r.sources);
  return rec;
}

/** `JSON.stringify(undefined)` is undefined; store it as NULL so a patch can clear a field. */
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

interface DocIndexRow {
  seq: number;
  object: string;
  offset: number;
  length: number;
  chars: number;
}

/**
 * Whether stored bytes look like one whole JSON object (`{`, then `}` before any trailing whitespace). A cheap guard
 * so bytes that no longer match the index (a file changed behind sex's back) never reach a response as broken JSON.
 */
function isJsonObject(bytes: Uint8Array): boolean {
  let end = bytes.length - 1;
  while (end > 0 && (bytes[end] === 0x0a || bytes[end] === 0x0d || bytes[end] === 0x20 || bytes[end] === 0x09)) end--;
  return bytes[0] === 0x7b && bytes[end] === 0x7d;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Job state in SQLite (bun:sqlite), in a file under SEX_DATA_DIR or in memory. Only this process opens the
 * database, and bun:sqlite calls are synchronous, so each method is atomic without explicit locking; multi-statement
 * updates still run in a transaction so a crash cannot leave them half applied. A job expires `ttlMs` after it finished;
 * running jobs are never swept (their `expires_at` is provisional, counted from creation, until they finish).
 *
 * Scraped documents are too large for rows (WAL checkpoints of ~200 KB rows stalled the event loop), so their bytes
 * go to a DocumentLog (JSONL files, S3 or memory) and the `documents` table only indexes them: object, offset and
 * byte length of each, plus its length in UTF-16 code units, which is what the page budget counts. A document is
 * appended first and indexed after, and its seq is assigned only then, so documents become visible in seq order
 * without holes that fill in later. A crash in between leaves bytes without an index row; they are cut off (JSONL)
 * or dropped with their job. Index rows past the end of a JSONL file (an OS crash lost its tail) are dropped on open.
 * Reads never change the index: a document whose bytes are missing or damaged is left out of the page with a
 * warning, because on S3 that can be transient or a configuration problem (wrong bucket, permissions, lifecycle
 * rules) rather than lost data.
 *
 * Every side effect of a task that must not repeat when the queue redelivers it (settling, its document, its failure,
 * a webhook) is claimed as a row of `task_effects`, keyed by (job, taskId, effect), in the transaction of the write it
 * guards. A document's bytes are appended before that transaction, so a redelivery that races its original (or finds
 * the index gone after a crash) leaves bytes that nothing indexes: orphans, cut off at the end of a JSONL file on open
 * and otherwise dropped with their job, never read because pages are chosen from the index.
 *
 * Documents are only ever deleted by job id, for jobs this store deleted: the sweep leaves a tombstone in
 * `dropped_jobs` in the same transaction that deletes the job, and removes it once `drop` succeeded, so a crash or a
 * failed drop is retried by the next sweep (one runs on open). Nothing is deleted because it was found in the log,
 * so a bucket, prefix or directory shared with other data is safe.
 */
export class SqliteJobStore implements JobStore {
  private readonly db: Database;
  private readonly sweeper: ReturnType<typeof setInterval>;
  /** Repair of a log that appends in place; appends and reads wait for it. Resolved at once for other logs. */
  private readonly ready: Promise<void>;
  /** Repair of a log that appends in place, awaited by close(). */
  private readonly recovery: Promise<void>;
  /** Document drops in progress by job id, awaited by close(). */
  private readonly dropping = new Map<string, Promise<void>>();

  constructor(
    path: string,
    private readonly ttlMs: number,
    private readonly docs: DocumentLog,
  ) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run("PRAGMA busy_timeout = 5000");
    // Before documents moved out of SQLite, `documents` held their JSON (and jobs.doc_count their number). That layout
    // was never released, so its documents are dropped rather than migrated.
    if (this.db.query("SELECT 1 FROM pragma_table_info('documents') WHERE name = 'json'").get()) {
      this.db.run("DROP TABLE documents");
      this.db.run("ALTER TABLE jobs DROP COLUMN doc_count");
    }
    this.db.run(SCHEMA);
    if (!this.db.query("SELECT 1 FROM pragma_table_info('jobs') WHERE name = 'warning'").get()) {
      this.db.run("ALTER TABLE jobs ADD COLUMN warning TEXT");
    }
    // `settled` (job_id, task_id) became the "settle" rows of `task_effects`; tasks in flight keep their settlements.
    if (this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settled'").get()) {
      this.db.transaction(() => {
        this.db.run("INSERT OR IGNORE INTO task_effects (job_id, task_id, effect) SELECT job_id, task_id, 'settle' FROM settled");
        this.db.run("DROP TABLE settled");
      })();
    }
    // Politeness-delay slots were reserved ahead of time; the scheduler now paces a job's pages while it runs.
    for (const [table, column] of [
      ["jobs", "slots"],
      ["jobs", "next_slot_at"],
      ["outbox", "run_at"],
    ] as const) {
      if (this.db.query(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = '${column}'`).get()) {
        this.db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      }
    }
    this.sweep();
    this.recovery = this.repair().catch((err) => log.warn("document repair failed", { error: errorText(err) }));
    // A log that appends in place must be repaired before the next append or read.
    this.ready = this.recovery;
    this.sweeper = setInterval(() => this.sweep(), 10 * 60 * 1000);
    this.sweeper.unref?.();
  }

  private jobExists(id: string) {
    return this.db.query("SELECT 1 FROM jobs WHERE id = ?").get(id) !== null;
  }

  /**
   * For a log that appends in place: cuts each job's object back to the end of its last indexed document (bytes
   * written before a crash but never indexed) and drops index rows past the end of the object (an OS crash lost its
   * tail). Only objects of jobs that exist are touched.
   */
  private async repair() {
    const truncate = this.docs.truncate?.bind(this.docs);
    if (!truncate) return;
    const ends = this.db
      .query<{ id: string; end: number }, []>(
        "SELECT id, coalesce(max(offset + length), 0) AS end FROM jobs LEFT JOIN documents ON job_id = id GROUP BY id",
      )
      .all();
    for (const { id, end } of ends) {
      const size = await truncate(id, end);
      if (size < end) {
        const lost = this.exec("DELETE FROM documents WHERE job_id = ? AND offset + length > ?", id, size).changes;
        log.warn("documents lost their bytes; dropped from the index", { job: id, count: lost });
        // Cut off what is left of the last, partly lost document too.
        const r = this.db
          .query<{ end: number }, [string]>("SELECT coalesce(max(offset + length), 0) AS end FROM documents WHERE job_id = ?")
          .get(id);
        await truncate(id, r?.end ?? 0);
      }
    }
  }

  private row(id: string): JobRow | null {
    return this.db.query<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?").get(id);
  }

  private exec(sql: string, ...params: SQLQueryBindings[]) {
    return this.db.query(sql).run(...params);
  }

  async create(init: Pick<JobRecord, "kind" | "url" | "options">): Promise<JobRecord> {
    const now = Date.now();
    const id = randomUUID();
    this.exec(
      "INSERT INTO jobs (id, kind, status, url, options, created_at, expires_at) VALUES (?, ?, 'scraping', ?, ?, ?, ?)",
      id,
      init.kind,
      init.url ?? null,
      JSON.stringify(init.options),
      now,
      now + this.ttlMs,
    );
    return toRecord(this.row(id) as JobRow);
  }

  async get(id: string) {
    const r = this.row(id);
    return r ? toRecord(r) : undefined;
  }

  async patch(id: string, patch: JobPatch) {
    this.db.transaction(() => this.applyPatch(id, patch))();
  }

  private applyPatch(id: string, patch: JobPatch) {
    if ("error" in patch) this.exec("UPDATE jobs SET error = ? WHERE id = ?", patch.error ?? null, id);
    if ("warning" in patch) this.exec("UPDATE jobs SET warning = ? WHERE id = ?", patch.warning ?? null, id);
    if ("result" in patch) this.exec("UPDATE jobs SET result = ? WHERE id = ?", json(patch.result), id);
    if ("sources" in patch) this.exec("UPDATE jobs SET sources = ? WHERE id = ?", json(patch.sources), id);
  }

  async finish(id: string, status: Exclude<JobState, "scraping">, patch?: JobPatch) {
    return this.db.transaction(() => {
      const changed =
        this.exec("UPDATE jobs SET status = ?, expires_at = ? WHERE id = ? AND status = 'scraping'", status, Date.now() + this.ttlMs, id)
          .changes > 0;
      if (changed && patch) this.applyPatch(id, patch);
      return changed;
    })();
  }

  async reopen(id: string) {
    this.exec("UPDATE jobs SET status = 'scraping' WHERE id = ? AND status = 'completed'", id);
  }

  async incr(id: string, counter: CounterName, by = 1) {
    if (!COUNTERS.has(counter)) throw new Error(`unknown counter ${counter}`);
    const r = this.db
      .query<Record<string, number>, [number, string]>(`UPDATE jobs SET ${counter} = ${counter} + ? WHERE id = ? RETURNING ${counter}`)
      .get(by, id);
    return r?.[counter] ?? 0;
  }

  /** Records that the task performed `effect`; false if it already had, or the job is gone. */
  private claim(id: string, taskId: string, effect: TaskEffect) {
    return (
      this.exec("INSERT OR IGNORE INTO task_effects (job_id, task_id, effect) SELECT id, ?, ? FROM jobs WHERE id = ?", taskId, effect, id)
        .changes > 0
    );
  }

  private claimed(id: string, taskId: string, effect: TaskEffect) {
    return this.db.query("SELECT 1 FROM task_effects WHERE job_id = ? AND task_id = ? AND effect = ?").get(id, taskId, effect) !== null;
  }

  async claimEffect(id: string, taskId: string | undefined, effect: TaskEffect) {
    return taskId === undefined ? this.jobExists(id) : this.claim(id, taskId, effect);
  }

  async settle(id: string, taskId: string | undefined, countCompleted = false) {
    return this.db.transaction(() => {
      if (taskId !== undefined && !this.claim(id, taskId, "settle")) return null;
      const r = this.db
        .query<{ pending: number }, [number, string]>(
          "UPDATE jobs SET pending = pending - 1, completed = completed + ? WHERE id = ? RETURNING pending",
        )
        .get(countCompleted ? 1 : 0, id);
      return r ? r.pending : null;
    })();
  }

  async pushDocument(id: string, doc: Document, taskId?: string, countCompleted = false) {
    await this.ready;
    if (!this.jobExists(id)) return false;
    // A redelivered task usually finds its document indexed already: skip the write instead of leaving orphan bytes.
    if (taskId !== undefined && this.claimed(id, taskId, "document")) return false;
    const json = JSON.stringify(doc);
    const ref = await this.docs.append(id, json);
    const outcome = this.db.transaction((): "stored" | "duplicate" | "gone" => {
      if (!this.jobExists(id)) return "gone";
      if (taskId !== undefined && !this.claim(id, taskId, "document")) return "duplicate";
      this.exec(
        `INSERT INTO documents (job_id, seq, object, offset, length, chars)
         VALUES (?1, (SELECT coalesce(max(seq) + 1, 0) FROM documents WHERE job_id = ?1), ?2, ?3, ?4, ?5)`,
        id,
        ref.object,
        ref.offset,
        ref.length,
        json.length,
      );
      if (countCompleted) this.exec("UPDATE jobs SET completed = completed + 1 WHERE id = ?", id);
      return "stored";
    })();
    if (outcome === "gone") {
      // The job expired while the document was being written, so the sweep's drop may have missed it.
      this.exec("INSERT OR IGNORE INTO dropped_jobs (job_id) VALUES (?)", id);
      await this.dropDocuments(id);
    }
    return outcome === "stored";
  }

  async documentsJson(id: string, skip: number, maxChars: number): Promise<{ data: Uint8Array[]; nextSkip: number | null }> {
    await this.ready;
    // The page is chosen from the index, so no document is read that is not returned. The first document is always
    // included, even when it alone exceeds maxChars.
    const page: DocIndexRow[] = [];
    let chars = 0;
    let more = false;
    // Not the cached query(): leaving iterate() early leaves its statement unusable for the next call.
    const rows = this.db.prepare<DocIndexRow, [string, number]>(
      "SELECT seq, object, offset, length, chars FROM documents WHERE job_id = ? AND seq >= ? ORDER BY seq",
    );
    try {
      for (const r of rows.iterate(id, skip)) {
        if (page.length > 0 && chars + r.chars > maxChars) {
          more = true;
          break;
        }
        chars += r.chars;
        page.push(r);
      }
    } finally {
      rows.finalize();
    }
    const last = page.at(-1);
    if (!last) return { data: [], nextSkip: null };

    // Runs of documents stored back to back in one object are read at once: a whole page of a JSONL file is one
    // read, while on S3 every document is its own read.
    const ranges: Array<{ object: string; offset: number; end: number; rows: DocIndexRow[] }> = [];
    for (const r of page) {
      const prev = ranges.at(-1);
      if (prev && prev.object === r.object && prev.end === r.offset) {
        prev.end += r.length;
        prev.rows.push(r);
      } else {
        ranges.push({ object: r.object, offset: r.offset, end: r.offset + r.length, rows: [r] });
      }
    }
    const limit = pLimit(READ_CONCURRENCY);
    const bytes = await Promise.all(ranges.map((g) => limit(() => this.docs.read(g.object, g.offset, g.end - g.offset))));
    const data: Uint8Array[] = [];
    const missing: number[] = [];
    for (const [i, g] of ranges.entries()) {
      const buf = bytes[i] as Uint8Array;
      for (const r of g.rows) {
        const at = r.offset - g.offset;
        const doc = at + r.length <= buf.length ? buf.subarray(at, at + r.length) : undefined;
        if (doc && isJsonObject(doc)) data.push(doc);
        else missing.push(r.seq);
      }
    }
    if (missing.length > 0) log.warn("documents unreadable; left out of the page", { job: id, seqs: missing.join(",") });
    return { data, nextSkip: more ? last.seq + 1 : null };
  }

  async documents(id: string, skip: number, maxChars: number) {
    const { data, nextSkip } = await this.documentsJson(id, skip, maxChars);
    const text = new TextDecoder();
    return { data: data.map((bytes) => JSON.parse(text.decode(bytes)) as Document), nextSkip };
  }

  async pushError(id: string, error: JobError, taskId?: string) {
    this.db.transaction(() => {
      if (taskId !== undefined && !this.claim(id, taskId, "error")) return;
      this.exec("INSERT INTO job_errors (job_id, json) SELECT id, ? FROM jobs WHERE id = ?", JSON.stringify(error), id);
    })();
  }

  async errors(id: string) {
    return this.db
      .query<{ json: string }, [string]>("SELECT json FROM job_errors WHERE job_id = ? ORDER BY rowid")
      .all(id)
      .map((r) => JSON.parse(r.json) as JobError);
  }

  async setRobotsTxt(id: string, text: string) {
    this.exec("UPDATE jobs SET robots_txt = ? WHERE id = ?", text, id);
  }

  async robotsTxt(id: string) {
    return this.db.query<{ t: string }, [string]>("SELECT robots_txt AS t FROM jobs WHERE id = ?").get(id)?.t ?? "";
  }

  async pushRobotsBlocked(id: string, url: string) {
    this.exec("INSERT INTO robots_blocked (job_id, url) SELECT id, ? FROM jobs WHERE id = ?", url, id);
  }

  async robotsBlocked(id: string) {
    return this.db
      .query<{ url: string }, [string]>("SELECT url FROM robots_blocked WHERE job_id = ? ORDER BY rowid")
      .all(id)
      .map((r) => r.url);
  }

  async claimSeen(id: string, taskId: string | undefined, key: string) {
    return this.db.transaction(() => {
      if (taskId !== undefined && this.claimed(id, taskId, "redirect")) return true;
      const fresh = this.exec("INSERT OR IGNORE INTO seen (job_id, key) SELECT id, ? FROM jobs WHERE id = ?", key, id).changes > 0;
      if (fresh && taskId !== undefined) this.claim(id, taskId, "redirect");
      return fresh;
    })();
  }

  async schedule(id: string, owner: string | undefined, candidates: LinkCandidate[], opts: ScheduleOptions) {
    return this.db.transaction((): OutboxTask[] => {
      const job = this.row(id);
      if (!job) return [];
      const seen = this.db.query("INSERT OR IGNORE INTO seen (job_id, key) VALUES (?, ?)");
      let room = Math.max(0, opts.limit - job.scheduled);
      const accepted: LinkCandidate[] = [];
      for (const c of candidates) {
        if (seen.run(id, c.key).changes === 0) continue;
        if (c.blocked) this.exec("INSERT INTO robots_blocked (job_id, url) VALUES (?, ?)", id, c.url);
        else if (room > 0) {
          accepted.push(c);
          room--;
        }
      }
      if (!accepted.length) return [];
      const n = accepted.length;
      this.exec("UPDATE jobs SET scheduled = scheduled + ?1, total = total + ?1, pending = pending + ?1 WHERE id = ?2", n, id);
      const insert = this.db.query("INSERT INTO outbox (job_id, task_id, owner, url, depth) VALUES (?, ?, ?, ?, ?)");
      return accepted.map((c) => {
        const task = { taskId: randomUUID(), url: c.url, depth: opts.depth };
        insert.run(id, task.taskId, owner ?? null, task.url, task.depth);
        return task;
      });
    })();
  }

  async outbox(id: string, owner: string) {
    return this.db
      .query<{ taskId: string; url: string; depth: number }, [string, string]>(
        "SELECT task_id AS taskId, url, depth FROM outbox WHERE job_id = ? AND owner = ? ORDER BY rowid",
      )
      .all(id, owner);
  }

  async released(id: string, taskIds: string[], queued: boolean) {
    this.db.transaction(() => {
      const remove = this.db.query("DELETE FROM outbox WHERE job_id = ? AND task_id = ?");
      const removed = taskIds.filter((t) => remove.run(id, t).changes > 0).length;
      if (!queued && removed) this.exec("UPDATE jobs SET pending = pending - ? WHERE id = ?", removed, id);
    })();
  }

  async active(kind: JobKind) {
    return this.db
      .query<JobRow, [string]>("SELECT * FROM jobs WHERE kind = ? AND status = 'scraping' ORDER BY created_at")
      .all(kind)
      .map(toRecord);
  }

  async close() {
    clearInterval(this.sweeper);
    await this.recovery;
    await Promise.all(this.dropping.values());
    this.db.close();
  }

  /** Deletes expired finished jobs, leaving a tombstone for each, then drops the documents of every tombstoned job. */
  private sweep() {
    this.db.transaction(() => {
      const gone = this.db
        .query<{ id: string }, [number]>("DELETE FROM jobs WHERE status != 'scraping' AND expires_at < ? RETURNING id")
        .all(Date.now());
      const tombstone = this.db.query("INSERT OR IGNORE INTO dropped_jobs (job_id) VALUES (?)");
      for (const { id } of gone) tombstone.run(id);
    })();
    for (const { job_id } of this.db.query<{ job_id: string }, []>("SELECT job_id FROM dropped_jobs").all()) {
      if (!this.dropping.has(job_id)) void this.dropDocuments(job_id);
    }
  }

  /**
   * Drops a tombstoned job's documents and then its tombstone; a failure leaves the tombstone for the next sweep.
   * Drops of one job run one after another (a late append can need a second one), and only the last removes it.
   */
  private dropDocuments(id: string): Promise<void> {
    const drop: Promise<void> = (this.dropping.get(id) ?? Promise.resolve())
      .then(() => this.docs.drop(id))
      .then(
        () => {
          if (this.dropping.get(id) === drop) this.exec("DELETE FROM dropped_jobs WHERE job_id = ?", id);
        },
        (err) => log.warn("dropping documents failed; retried by the next sweep", { job: id, error: errorText(err) }),
      )
      .finally(() => {
        if (this.dropping.get(id) === drop) this.dropping.delete(id);
      });
    this.dropping.set(id, drop);
    return drop;
  }
}
