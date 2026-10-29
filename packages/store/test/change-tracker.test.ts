import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { markdownDiff, SqliteChangeTracker } from "@searxng-js/sex-store";

describe("SqliteChangeTracker", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "sex-track-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("keeps one row per (url, tag), replaced by put, and never expires it", async () => {
    const tracker = new SqliteChangeTracker(join(dir, "tracker.sqlite"));
    await tracker.put("https://a.test/", null, "one", 1);
    await tracker.put("https://a.test/", "t", "tagged", 2);
    await tracker.put("https://a.test/", null, "two ".repeat(1000), 1_000);
    assert.deepEqual(await tracker.get("https://a.test/", null), { markdown: "two ".repeat(1000), scrapedAt: 1_000 });
    assert.deepEqual(await tracker.get("https://a.test/", "t"), { markdown: "tagged", scrapedAt: 2 });
    assert.equal(await tracker.get("https://a.test/", "other"), undefined);
    // A null tag and "" are the same row.
    assert.equal((await tracker.get("https://a.test/", ""))?.scrapedAt, 1_000);
    tracker.close();
    const reopened = new SqliteChangeTracker(join(dir, "tracker.sqlite"));
    assert.equal((await reopened.get("https://a.test/", "t"))?.markdown, "tagged");
    reopened.close();
  });

  test("opens a change-tracking.sqlite written by the Bun-only version", async () => {
    const file = join(dir, "legacy.sqlite");
    const old = new DatabaseSync(file);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(`CREATE TABLE IF NOT EXISTS change_tracking (
          url TEXT NOT NULL,
          tag TEXT NOT NULL,
          scraped_at INTEGER NOT NULL,
          markdown BLOB NOT NULL,
          PRIMARY KEY (url, tag)
        ) WITHOUT ROWID`);
    old.exec("PRAGMA user_version = 1");
    old
      .prepare("INSERT INTO change_tracking VALUES ('https://a.test/', '', 7, ?)")
      .run(zstdCompressSync(new TextEncoder().encode("# old")));
    old.close();
    const tracker = new SqliteChangeTracker(file);
    assert.deepEqual(await tracker.get("https://a.test/", null), { markdown: "# old", scrapedAt: 7 });
    tracker.close();
  });

  test("a file from a newer version is refused, not recreated", async () => {
    const file = join(dir, "newer.sqlite");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA user_version = 9");
    db.close();
    const tracker = new SqliteChangeTracker(file);
    await assert.rejects(tracker.get("https://a.test/", null), /newer/);
  });

  test("diff gives up on a time that has run out instead of blocking", () => {
    const tracker = new SqliteChangeTracker(":memory:");
    const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i} ${Math.random()}`).join("\n");
    const started = Date.now();
    const diff = tracker.diff(lines(20_000, "a"), lines(20_000, "b"), { deadlineAt: Date.now() + 50 });
    assert.ok(Date.now() - started < 2000);
    assert.equal(diff, undefined);
    tracker.close();
  });
});

describe("markdownDiff", () => {
  test("reports the unified text and Firecrawl's json shape", () => {
    const diff = markdownDiff("a\nb\nc\n", "a\nB\nc\n", 1000);
    assert.ok(diff?.text.includes("-b"));
    assert.ok(diff?.text.includes("+B"));
    assert.ok(diff);
    type DiffJson = { files: Array<{ from: string; to: string; chunks: Array<{ changes: Array<{ type: string }> }> }> };
    const file = (diff.json as DiffJson).files[0];
    assert.equal(file?.from, "previous.md");
    assert.deepEqual(
      file?.chunks.flatMap((c) => c.changes.map((x) => x.type)),
      ["normal", "del", "add", "normal"],
    );
  });

  test("no difference is undefined", () => {
    assert.equal(markdownDiff("same\n", "same\n", 1000), undefined);
  });
});
