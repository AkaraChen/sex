import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { CachedPage, CacheKey, ScrapeCache } from "@searxng-js/sex-scrape";
import { log } from "./log.ts";
import { Sqlite } from "./sqlite.ts";

/** Bumped when the table changes; a cache is only a copy, so a different version is dropped, not migrated. */
const SCHEMA_VERSION = 1;

/** A page whose stored size is above this share of the limit is not kept: one big PDF would push out everything else. */
const MAX_ENTRY_SHARE = 8;

/** How often `put` looks for expired entries (one also runs on open). */
const SWEEP_EVERY_MS = 10 * 60 * 1000;

export interface PageCacheOptions {
  /** The `maxAge` of a request that has none; 0 = always fetch. */
  defaultMaxAge: number;
  /** Entries older than this (ms) are deleted. */
  ttlMs: number;
  /** Most bytes the entries may take together (stored, i.e. compressed). */
  maxBytes: number;
  now?: () => number;
}

/**
 * `ScrapeCache` on node:sqlite: one row per (URL, variant) holding the zstd-compressed body, in its own file so big blobs
 * and their WAL stay out of jobs.sqlite. (DocumentLog does not fit: it appends per job and deletes only whole jobs, while a
 * cache evicts single entries.) The file is opened on first use. Expiry is by age (`ttlMs`), the size limit evicts the least
 * recently used entries; a hit is one indexed read and a decompression, and refreshes `used_at`.
 */
export class SqliteScrapeCache implements ScrapeCache {
  readonly defaultMaxAge: number;
  readonly retention: number;
  private db?: Sqlite;
  /** Sum of `size` over the table; this process is the only writer. */
  private bytes = 0;
  private lastSweep = 0;
  private readonly now: () => number;

  constructor(
    private readonly path: string,
    private readonly opts: PageCacheOptions,
  ) {
    this.defaultMaxAge = opts.defaultMaxAge;
    this.retention = opts.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  private open(): Sqlite {
    if (this.db) return this.db;
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    let db: Sqlite;
    try {
      db = this.connect();
    } catch (err) {
      // It is only a copy of pages that can be fetched again: a file that is not a database is replaced, not reported forever.
      log.warn("page cache file is unusable and is recreated", {
        path: this.path,
        error: err instanceof Error ? err.message : String(err),
      });
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${this.path}${suffix}`, { force: true });
      db = this.connect();
    }
    this.db = db;
    this.sweep();
    return db;
  }

  private connect(): Sqlite {
    const db = new Sqlite(this.path);
    try {
      return this.prepare(db);
    } catch (err) {
      db.close();
      throw err;
    }
  }

  private prepare(db: Sqlite): Sqlite {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
    const version = db.get<{ user_version: number }>("PRAGMA user_version");
    if (version?.user_version !== SCHEMA_VERSION) {
      db.exec("DROP TABLE IF EXISTS page_cache");
      db.exec(`CREATE TABLE page_cache (
        url TEXT NOT NULL,
        variant TEXT NOT NULL,
        stored_at INTEGER NOT NULL,
        used_at INTEGER NOT NULL,
        final_url TEXT NOT NULL,
        status INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        body BLOB NOT NULL,
        PRIMARY KEY (url, variant)
      )`);
      db.exec("CREATE INDEX page_cache_stored ON page_cache (stored_at)");
      db.exec("CREATE INDEX page_cache_used ON page_cache (used_at)");
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    return db;
  }

  async get(key: CacheKey, age: { minAge?: number; maxAge: number }): Promise<(CachedPage & { storedAt: number }) | undefined> {
    try {
      const db = this.open();
      const now = this.now();
      const row = db.get<{
        stored_at: number;
        final_url: string;
        status: number;
        content_type: string;
        body: Uint8Array;
      }>(
        "SELECT stored_at, final_url, status, content_type, body FROM page_cache WHERE url = $url AND variant = $variant AND stored_at <= $newest AND stored_at >= $oldest",
        { url: key.url, variant: key.variant, newest: now - (age.minAge ?? 0), oldest: now - age.maxAge },
      );
      if (!row) return undefined;
      db.run("UPDATE page_cache SET used_at = $now WHERE url = $url AND variant = $variant", {
        now,
        url: key.url,
        variant: key.variant,
      });
      return {
        storedAt: row.stored_at,
        url: row.final_url,
        status: row.status,
        contentType: row.content_type,
        body: zstdDecompressSync(row.body),
      };
    } catch (err) {
      // A damaged file or entry is a miss; the page is fetched.
      log.warn("page cache read failed", { url: key.url, error: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  async put(key: CacheKey, page: CachedPage): Promise<void> {
    try {
      const db = this.open();
      const body = zstdCompressSync(page.body);
      if (body.length > this.opts.maxBytes / MAX_ENTRY_SHARE) return;
      const now = this.now();
      db.transaction(() => {
        const old = db.get<{ size: number }>("DELETE FROM page_cache WHERE url = $url AND variant = $variant RETURNING size", {
          url: key.url,
          variant: key.variant,
        });
        if (old) this.bytes -= old.size;
        db.run(
          "INSERT INTO page_cache (url, variant, stored_at, used_at, final_url, status, content_type, size, body) VALUES ($url, $variant, $now, $now, $finalUrl, $status, $contentType, $size, $body)",
          {
            url: key.url,
            variant: key.variant,
            now,
            finalUrl: page.url,
            status: page.status,
            contentType: page.contentType,
            size: body.length,
            body,
          },
        );
        this.bytes += body.length;
        this.evict(db);
      });
      if (now - this.lastSweep > SWEEP_EVERY_MS) this.sweep();
    } catch (err) {
      log.warn("page cache write failed", { url: key.url, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Deletes the least recently used entries until the stored size fits `maxBytes`. */
  private evict(db: Sqlite) {
    if (this.bytes <= this.opts.maxBytes) return;
    const rows = db.all<{ url: string; variant: string; size: number }>(
      "SELECT url, variant, size FROM page_cache ORDER BY used_at, stored_at",
    );
    for (const row of rows) {
      if (this.bytes <= this.opts.maxBytes) break;
      db.run("DELETE FROM page_cache WHERE url = $url AND variant = $variant", { url: row.url, variant: row.variant });
      this.bytes -= row.size;
    }
  }

  /** Deletes entries past `ttlMs` and recounts the stored size. */
  private sweep() {
    const db = this.db;
    if (!db) return;
    this.lastSweep = this.now();
    db.run("DELETE FROM page_cache WHERE stored_at < $oldest", { oldest: this.lastSweep - this.opts.ttlMs });
    this.bytes = db.get<{ bytes: number }>("SELECT COALESCE(SUM(size), 0) AS bytes FROM page_cache")?.bytes ?? 0;
  }

  close() {
    this.db?.close();
    this.db = undefined;
  }
}
