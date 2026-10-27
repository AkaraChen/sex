import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import pLimit from "p-limit";
import { log } from "../../log.ts";
import type { Document } from "../../schemas.ts";
import { type DocumentLog, READ_CONCURRENCY } from "./documents.ts";
import type { CounterName, JobError, JobKind, JobPatch, JobRecord, JobState, JobStore } from "./types.ts";

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
  result TEXT,
  sources TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  scheduled INTEGER NOT NULL DEFAULT 0,
  slots INTEGER NOT NULL DEFAULT 0,
  next_slot_at INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS settled (
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  PRIMARY KEY (job_id, task_id)
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
  result: string | null;
  sources: string | null;
  total: number;
  completed: number;
  pending: number;
  scheduled: number;
  slots: number;
}

const COUNTERS = new Set<CounterName>(["total", "completed", "pending", "scheduled", "slots"]);

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
    slots: r.slots,
  };
  if (r.url !== null) rec.url = r.url;
  if (r.error !== null) rec.error = r.error;
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

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Job state in SQLite (bun:sqlite), in a file under SEX_DATA_DIR or in memory. Only this process opens the
 * database, and bun:sqlite calls are synchronous, so each method is atomic without explicit locking; multi-statement
 * updates still run in a transaction so a crash cannot leave them half applied. Jobs expire after `ttlMs`.
 *
 * Scraped documents are too large for rows (WAL checkpoints of ~200 KB rows stalled the event loop), so their bytes
 * go to a DocumentLog (JSONL files, S3 or memory) and the `documents` table only indexes them: object, offset and
 * byte length of each, plus its length in UTF-16 code units, which is what the page budget counts. A document is
 * appended first and indexed after, and its seq is assigned only then, so documents become visible in seq order
 * without holes that fill in later. A crash in between leaves bytes without an index row; they are cut off (JSONL)
 * or dropped with their job. Index rows whose bytes are gone (an OS crash lost the end of a file, or an object is
 * missing) are dropped on open (JSONL) or when a read comes up short.
 */
export class SqliteJobStore implements JobStore {
  private readonly db: Database;
  private readonly sweeper: ReturnType<typeof setInterval>;
  /** Repair of a log that appends in place; appends and reads wait for it. Resolved at once for other logs. */
  private readonly ready: Promise<void>;
  /** Orphan cleanup (and repair), awaited only by close(). */
  private readonly recovery: Promise<void>;
  /** Document drops started by the sweep, awaited by close(). */
  private readonly dropping = new Set<Promise<void>>();

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
    this.sweep();
    this.recovery = this.recover().catch((err) => log.warn("document recovery failed", { error: errorText(err) }));
    // A log that appends in place must be repaired before the next append. Other logs (S3) are cleaned up in the
    // background, so startup does not wait on listing a bucket.
    this.ready = this.docs.truncate ? this.recovery : Promise.resolve();
    this.sweeper = setInterval(() => this.sweep(), 10 * 60 * 1000);
    this.sweeper.unref?.();
  }

  private jobExists(id: string) {
    return this.db.query("SELECT 1 FROM jobs WHERE id = ?").get(id) !== null;
  }

  /**
   * Drops the documents of jobs that no longer exist (the sweep deleted the job but not its documents before a crash).
   * For a log that appends in place it also cuts each job's object back to the end of its last indexed document and
   * drops index rows past the end of the object.
   */
  private async recover() {
    // Listed first and checked after: a job's documents are only written while the job exists, so a job that is
    // missing now really is gone, even if it was created after this store opened.
    for (const id of await this.docs.jobs()) if (!this.jobExists(id)) await this.docs.drop(id);
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
    if ("result" in patch) this.exec("UPDATE jobs SET result = ? WHERE id = ?", json(patch.result), id);
    if ("sources" in patch) this.exec("UPDATE jobs SET sources = ? WHERE id = ?", json(patch.sources), id);
  }

  async finish(id: string, status: Exclude<JobState, "scraping">, patch?: JobPatch) {
    return this.db.transaction(() => {
      const changed = this.exec("UPDATE jobs SET status = ? WHERE id = ? AND status = 'scraping'", status, id).changes > 0;
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

  async settle(id: string, taskId: string | undefined, countCompleted = false) {
    return this.db.transaction(() => {
      if (taskId !== undefined) {
        const fresh = this.exec("INSERT OR IGNORE INTO settled (job_id, task_id) SELECT id, ? FROM jobs WHERE id = ?", taskId, id);
        if (fresh.changes === 0) return null;
      }
      const r = this.db
        .query<{ pending: number }, [number, string]>(
          "UPDATE jobs SET pending = pending - 1, completed = completed + ? WHERE id = ? RETURNING pending",
        )
        .get(countCompleted ? 1 : 0, id);
      return r ? r.pending : null;
    })();
  }

  async reserveSlots(id: string, count: number, intervalMs: number, now: number) {
    const r = this.db
      .query<{ start: number }, [number, number, number, string]>(
        "UPDATE jobs SET next_slot_at = max(?1, next_slot_at) + ?2 * ?3 WHERE id = ?4 RETURNING next_slot_at - ?2 * ?3 AS start",
      )
      .get(now, count, intervalMs, id);
    return r?.start ?? now;
  }

  async pushDocument(id: string, doc: Document) {
    await this.ready;
    if (!this.jobExists(id)) return;
    const json = JSON.stringify(doc);
    const ref = await this.docs.append(id, json);
    const added = this.exec(
      `INSERT INTO documents (job_id, seq, object, offset, length, chars)
       SELECT id, (SELECT coalesce(max(seq) + 1, 0) FROM documents WHERE job_id = ?1), ?2, ?3, ?4, ?5 FROM jobs WHERE id = ?1`,
      id,
      ref.object,
      ref.offset,
      ref.length,
      json.length,
    ).changes;
    // The job expired while the document was being written: its documents are orphans now.
    if (added === 0) await this.docs.drop(id);
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
    const lost: number[] = [];
    for (const [i, g] of ranges.entries()) {
      const buf = bytes[i] as Uint8Array;
      for (const r of g.rows) {
        const at = r.offset - g.offset;
        if (at + r.length <= buf.length) data.push(buf.subarray(at, at + r.length));
        else lost.push(r.seq);
      }
    }
    if (lost.length > 0) {
      // The bytes are gone (the object is missing or shorter than indexed): forget those documents and page again.
      this.exec("DELETE FROM documents WHERE job_id = ? AND seq IN (SELECT value FROM json_each(?))", id, JSON.stringify(lost));
      log.warn("documents lost their bytes; dropped from the index", { job: id, count: lost.length });
      return this.documentsJson(id, skip, maxChars);
    }
    return { data, nextSkip: more ? last.seq + 1 : null };
  }

  async documents(id: string, skip: number, maxChars: number) {
    const { data, nextSkip } = await this.documentsJson(id, skip, maxChars);
    const text = new TextDecoder();
    return { data: data.map((bytes) => JSON.parse(text.decode(bytes)) as Document), nextSkip };
  }

  async pushError(id: string, error: JobError) {
    this.exec("INSERT INTO job_errors (job_id, json) SELECT id, ? FROM jobs WHERE id = ?", JSON.stringify(error), id);
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

  async markSeen(id: string, keys: string[]) {
    const insert = this.db.query("INSERT OR IGNORE INTO seen (job_id, key) SELECT id, ? FROM jobs WHERE id = ?");
    return this.db.transaction(() => keys.map((k) => insert.run(k, id).changes > 0))();
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
    await Promise.all(this.dropping);
    this.db.close();
  }

  private sweep() {
    const gone = this.db.query<{ id: string }, [number]>("DELETE FROM jobs WHERE expires_at < ? RETURNING id").all(Date.now());
    // The rows go first: documents whose drop fails or is cut short by a crash are orphans, dropped on the next open.
    for (const { id } of gone) {
      const drop = this.docs
        .drop(id)
        .catch((err) => log.warn("dropping documents failed", { job: id, error: errorText(err) }))
        .finally(() => this.dropping.delete(drop));
      this.dropping.add(drop);
    }
  }
}
