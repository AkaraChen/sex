import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Document } from "../../schemas.ts";
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
  doc_count INTEGER NOT NULL DEFAULT 0,
  next_slot_at INTEGER NOT NULL DEFAULT 0,
  robots_txt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS jobs_active ON jobs (kind, status);
CREATE INDEX IF NOT EXISTS jobs_expiry ON jobs (expires_at);
CREATE TABLE IF NOT EXISTS documents (
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  size INTEGER NOT NULL,
  json TEXT NOT NULL,
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

/**
 * Job state in SQLite (bun:sqlite), in a file under SEX_DATA_DIR or in memory. Only this process opens the
 * database, and bun:sqlite calls are synchronous, so each method is atomic without explicit locking; multi-statement
 * updates still run in a transaction so a crash cannot leave them half applied. Jobs expire after `ttlMs`.
 */
export class SqliteJobStore implements JobStore {
  private readonly db: Database;
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    path: string,
    private readonly ttlMs: number,
  ) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(SCHEMA);
    this.sweep();
    this.sweeper = setInterval(() => this.sweep(), 10 * 60 * 1000);
    this.sweeper.unref?.();
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
    const body = JSON.stringify(doc);
    this.db.transaction(() => {
      const r = this.db
        .query<{ seq: number }, [string]>("UPDATE jobs SET doc_count = doc_count + 1 WHERE id = ? RETURNING doc_count - 1 AS seq")
        .get(id);
      if (r) this.exec("INSERT INTO documents (job_id, seq, size, json) VALUES (?, ?, ?, ?)", id, r.seq, body.length, body);
    })();
  }

  async documents(id: string, skip: number, maxChars: number) {
    // Sizes are read first so a page never loads more document bodies than it returns. The first document is
    // always included, even when it alone exceeds maxChars.
    const sizes = this.db
      .query<{ size: number }, [string, number]>("SELECT size FROM documents WHERE job_id = ? AND seq >= ? ORDER BY seq")
      .all(id, skip);
    let count = 0;
    let chars = 0;
    for (const { size } of sizes) {
      if (count > 0 && chars + size > maxChars) break;
      chars += size;
      count++;
    }
    const data = this.db
      .query<{ json: string }, [string, number, number]>("SELECT json FROM documents WHERE job_id = ? AND seq >= ? ORDER BY seq LIMIT ?")
      .all(id, skip, count)
      .map((r) => JSON.parse(r.json) as Document);
    return { data, nextSkip: count < sizes.length ? skip + count : null };
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
    this.db.close();
  }

  private sweep() {
    this.exec("DELETE FROM jobs WHERE expires_at < ?", Date.now());
  }
}
