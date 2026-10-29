import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CallTime, ChangeTracker, TrackedPage } from "@searxng-js/sex-scrape";
import { Deadline } from "../deadline.ts";
import { markdownDiff } from "./change-diff.ts";

/** Bumped when the table changes. Unlike the page cache this file is the only copy of its data, so a bump must migrate. */
const SCHEMA_VERSION = 1;

/**
 * `ChangeTracker` on bun:sqlite: one row per (URL, tag) with the zstd-compressed markdown of the latest scrape, in its own file
 * (`<dataDir>/change-tracking.sqlite`). Not `SqliteScrapeCache`: that one expires and evicts, while a row here is the only copy
 * of what the next scrape is compared with, and it lives until the next scrape replaces it. Nothing deletes rows. A file that
 * cannot be opened is an error, never recreated, so a broken disk does not silently turn every page into `new`.
 */
export class SqliteChangeTracker implements ChangeTracker {
  private db?: Database;

  constructor(private readonly path: string) {}

  private open(): Database {
    if (this.db) return this.db;
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    const db = new Database(this.path, { create: true, strict: true });
    try {
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA synchronous = NORMAL");
      db.run("PRAGMA busy_timeout = 5000");
      const { user_version: version } = db.query("PRAGMA user_version").get() as { user_version: number };
      if (version > SCHEMA_VERSION) throw new Error(`${this.path} was written by a newer sex (schema ${version})`);
      if (version < SCHEMA_VERSION) {
        db.run(`CREATE TABLE IF NOT EXISTS change_tracking (
          url TEXT NOT NULL,
          tag TEXT NOT NULL,
          scraped_at INTEGER NOT NULL,
          markdown BLOB NOT NULL,
          PRIMARY KEY (url, tag)
        ) WITHOUT ROWID`);
        db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }
    } catch (err) {
      db.close();
      throw err;
    }
    this.db = db;
    return db;
  }

  async get(url: string, tag: string | null): Promise<TrackedPage | undefined> {
    const row = this.open()
      .query("SELECT scraped_at, markdown FROM change_tracking WHERE url = $url AND tag = $tag")
      .get({ url, tag: tag ?? "" }) as { scraped_at: number; markdown: Uint8Array } | null;
    if (!row) return undefined;
    return { scrapedAt: row.scraped_at, markdown: new TextDecoder().decode(Bun.zstdDecompressSync(row.markdown)) };
  }

  async put(url: string, tag: string | null, markdown: string, scrapedAt: number): Promise<void> {
    this.open()
      .query(
        "INSERT INTO change_tracking (url, tag, scraped_at, markdown) VALUES ($url, $tag, $scrapedAt, $markdown) ON CONFLICT (url, tag) DO UPDATE SET scraped_at = excluded.scraped_at, markdown = excluded.markdown",
      )
      .run({ url, tag: tag ?? "", scrapedAt, markdown: Bun.zstdCompressSync(new TextEncoder().encode(markdown)) });
  }

  diff(previous: string, current: string, time: CallTime) {
    return markdownDiff(previous, current, Deadline.of(time).remaining());
  }

  close() {
    this.db?.close();
    this.db = undefined;
  }
}
