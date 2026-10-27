// JobStore behaviour against every DocumentLog: memory and JSONL files.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DocumentLog, FsDocumentLog, MemoryDocumentLog } from "../src/core/jobs/documents.ts";
import { SqliteJobStore } from "../src/core/jobs/sqlite.ts";
import type { Document } from "../src/schemas.ts";

const dir = mkdtempSync(join(tmpdir(), "sex-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const doc = (n: number, text = "x") => ({ markdown: text.repeat(n), metadata: { sourceURL: `https://e.com/${n}` } });

/** Every page of a job's documents, following nextSkip. */
async function allPages(store: SqliteJobStore, id: string, maxChars: number) {
  const pages: Document[][] = [];
  let skip: number | null = 0;
  while (skip !== null) {
    const page: Awaited<ReturnType<SqliteJobStore["documents"]>> = await store.documents(id, skip, maxChars);
    pages.push(page.data);
    skip = page.nextSkip;
  }
  return pages;
}

/** Job ids that still have stored documents. */
type Stored = () => Promise<string[]>;
let logs = 0;
const backends: Array<[string, () => { log: DocumentLog; stored: Stored }]> = [
  ["memory", () => ((log) => ({ log, stored: () => log.jobs() }))(new MemoryDocumentLog())],
  ["file", () => ((log) => ({ log, stored: () => log.jobs() }))(new FsDocumentLog(join(dir, `docs-${logs++}`)))],
];

for (const [name, makeLog] of backends) {
  describe(`job store contract (${name})`, () => {
    const { log: docs } = makeLog();
    const store = new SqliteJobStore(":memory:", 60_000, docs);
    afterAll(() => store.close());

    test("documents() pages by size without skipping or repeating items", async () => {
      const job = await store.create({ kind: "batch_scrape", options: {} });
      const sizes = [500, 500, 500, 5000, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100];
      for (const n of sizes) await store.pushDocument(job.id, doc(n));

      const seen: number[] = [];
      let skip: number | null = 0;
      let pages = 0;
      while (skip !== null) {
        const page: Awaited<ReturnType<typeof store.documents>> = await store.documents(job.id, skip, 1200);
        expect(page.data.length).toBeGreaterThan(0);
        for (const d of page.data) seen.push(d.markdown?.length ?? 0);
        skip = page.nextSkip;
        pages++;
      }
      expect(seen).toEqual(sizes);
      expect(pages).toBeGreaterThan(2);
    });

    test("documents() on an empty job returns nothing and no next page", async () => {
      const job = await store.create({ kind: "batch_scrape", options: {} });
      expect(await store.documents(job.id, 0, 1000)).toEqual({ data: [], nextSkip: null });
      expect(await store.documents(job.id, 5, 1000)).toEqual({ data: [], nextSkip: null });
      expect(await store.documentsJson(job.id, 0, 1000)).toEqual({ data: [], nextSkip: null });
      expect(await store.documents("missing", 0, 1000)).toEqual({ data: [], nextSkip: null });
    });

    test("a document larger than the budget still comes back, alone on its page", async () => {
      const job = await store.create({ kind: "batch_scrape", options: {} });
      for (const n of [5000, 10, 6000, 10, 10]) await store.pushDocument(job.id, doc(n));
      const pages = await allPages(store, job.id, 1000);
      expect(pages.map((p) => p.map((d) => d.markdown?.length))).toEqual([[5000], [10], [6000], [10, 10]]);
    });

    test("the budget counts characters, and multi-byte text round-trips", async () => {
      const job = await store.create({ kind: "batch_scrape", options: {} });
      const docs = [doc(100, "é"), doc(100, "中"), doc(50, "😀"), doc(100, "x")];
      for (const d of docs) await store.pushDocument(job.id, d);
      const size = JSON.stringify(docs[0]).length;
      // Two documents fit by characters, though the first two take 500 bytes of UTF-8.
      expect((await store.documents(job.id, 0, 2 * size + 1)).data).toEqual(docs.slice(0, 2));
      expect((await allPages(store, job.id, 1e6)).flat()).toEqual(docs);
    });

    test("documentsJson() is the same page as documents(), as JSON texts", async () => {
      const job = await store.create({ kind: "crawl", url: "https://e.com/", options: {} });
      for (const n of [10, 20, 30]) await store.pushDocument(job.id, { ...doc(n, 'a\n"b'), metadata: { title: "t\u2028" } });
      for (const [skip, max] of [
        [0, 1e6],
        [1, 1e6],
        [0, 50],
        [2, 1],
      ] as const) {
        const raw = await store.documentsJson(job.id, skip, max);
        const parsed = await store.documents(job.id, skip, max);
        const text = new TextDecoder();
        expect(JSON.parse(`[${raw.data.map((d) => text.decode(d)).join(",")}]`)).toEqual(parsed.data);
        expect(raw.nextSkip).toBe(parsed.nextSkip);
      }
    });

    test("documents of jobs written in turn stay with their job and in order", async () => {
      const jobs = await Promise.all([1, 2, 3].map(() => store.create({ kind: "batch_scrape", options: {} })));
      for (let i = 0; i < 30; i++) {
        const job = jobs[i % 3]!;
        await store.pushDocument(job.id, { markdown: `${i % 3}:${i}:${"y".repeat(i * 37)}`, metadata: {} });
      }
      await store.pushDocument("missing", doc(1));
      for (const [k, job] of jobs.entries()) {
        const got = (await allPages(store, job.id, 400)).flat().map((d) => d.markdown?.split(":").slice(0, 2).join(":"));
        expect(got).toEqual(Array.from({ length: 10 }, (_, j) => `${k}:${j * 3 + k}`));
      }
    });

    test("robots.txt is stored beside the job, not in its record", async () => {
      const job = await store.create({ kind: "crawl", url: "https://e.com/", options: {} });
      expect(await store.robotsTxt(job.id)).toBe("");
      await store.setRobotsTxt(job.id, "User-agent: *\nDisallow: /x\n");
      expect(await store.robotsTxt(job.id)).toBe("User-agent: *\nDisallow: /x\n");
      expect(Object.keys((await store.get(job.id)) ?? {})).not.toContain("robotsTxt");
    });

    test("settle counts a taskId once and completes only from pending", async () => {
      const job = await store.create({ kind: "batch_scrape", options: {} });
      await store.incr(job.id, "pending", 2);
      expect(await store.settle(job.id, "t1", true)).toBe(1);
      expect(await store.settle(job.id, "t1", true)).toBeNull();
      expect(await store.settle(job.id, "t2")).toBe(0);
      const after = await store.get(job.id);
      expect({ pending: after?.pending, completed: after?.completed }).toEqual({ pending: 0, completed: 1 });
      expect(await store.settle("missing", "t", true)).toBeNull();
    });

    test("finish moves a job out of scraping once, with its patch", async () => {
      const job = await store.create({ kind: "extract", options: { a: 1 } });
      expect(await store.finish(job.id, "completed", { result: { x: [1] }, sources: { s: 1 } })).toBe(true);
      expect(await store.finish(job.id, "failed", { error: "late" })).toBe(false);
      const done = await store.get(job.id);
      expect(done).toMatchObject({ status: "completed", result: { x: [1] }, sources: { s: 1 }, options: { a: 1 } });
      expect(done?.error).toBeUndefined();
      await store.reopen(job.id);
      expect((await store.active("extract")).map((j) => j.id)).toContain(job.id);
    });

    test("markSeen, errors and robots lists are per job and ordered", async () => {
      const a = await store.create({ kind: "crawl", url: "https://a/", options: {} });
      const b = await store.create({ kind: "crawl", url: "https://b/", options: {} });
      expect(await store.markSeen(a.id, ["x", "y", "x"])).toEqual([true, true, false]);
      expect(await store.markSeen(b.id, ["x"])).toEqual([true]);
      await store.pushError(a.id, { id: "1", timestamp: "t", url: "u1", error: "e1" });
      await store.pushError(a.id, { id: "2", timestamp: "t", url: "u2", error: "e2" });
      expect((await store.errors(a.id)).map((e) => e.id)).toEqual(["1", "2"]);
      expect(await store.errors(b.id)).toEqual([]);
      await store.pushRobotsBlocked(a.id, "https://a/p");
      expect(await store.robotsBlocked(a.id)).toEqual(["https://a/p"]);
    });

    test("a reopened store keeps jobs and documents, and appends after them", async () => {
      const path = join(dir, `reopen-${name}.sqlite`);
      const { log } = makeLog();
      const first = new SqliteJobStore(path, 60_000, log);
      const job = await first.create({ kind: "crawl", url: "https://e.com/", options: { limit: 3 } });
      await first.incr(job.id, "pending", 2);
      await first.pushDocument(job.id, { markdown: "kept", metadata: {} });
      await first.markSeen(job.id, ["https://e.com/"]);
      await first.close();

      const second = new SqliteJobStore(path, 60_000, log);
      expect(await second.get(job.id)).toMatchObject({ status: "scraping", pending: 2, options: { limit: 3 } });
      expect((await second.documents(job.id, 0, 1e6)).data).toEqual([{ markdown: "kept", metadata: {} }]);
      await second.pushDocument(job.id, { markdown: "more", metadata: {} });
      expect((await second.documents(job.id, 0, 1e6)).data.map((d) => d.markdown)).toEqual(["kept", "more"]);
      expect(await second.markSeen(job.id, ["https://e.com/"])).toEqual([false]);
      await second.close();
    });

    test("the TTL sweep drops a job's documents, on open and periodically", async () => {
      const path = join(dir, `sweep-${name}.sqlite`);
      const { log, stored } = makeLog();
      const expired = new SqliteJobStore(path, -1, log);
      const onOpen = await expired.create({ kind: "batch_scrape", options: {} });
      await expired.pushDocument(onOpen.id, doc(10));
      await expired.close();
      expect(await stored()).toEqual([onOpen.id]);

      // Opening the store sweeps expired jobs, together with their documents and lists.
      const store = new SqliteJobStore(path, -1, log);
      expect(await store.get(onOpen.id)).toBeUndefined();
      const periodic = await store.create({ kind: "batch_scrape", options: {} });
      await store.pushDocument(periodic.id, doc(10));
      (store as unknown as { sweep(): void }).sweep();
      expect(await store.get(periodic.id)).toBeUndefined();
      await store.close();
      expect(await stored()).toEqual([]);
    });

    test("opening a store drops documents of jobs it does not have", async () => {
      const path = join(dir, `orphans-${name}.sqlite`);
      const { log, stored } = makeLog();
      const store = new SqliteJobStore(path, 60_000, log);
      const job = await store.create({ kind: "batch_scrape", options: {} });
      await store.pushDocument(job.id, doc(10));
      await store.close();
      await log.append("no-such-job", JSON.stringify(doc(5)));

      const reopened = new SqliteJobStore(path, 60_000, log);
      await reopened.close();
      expect(await stored()).toEqual([job.id]);
    });

    test("documents whose bytes are gone are dropped from the index on read", async () => {
      const job = await store.create({ kind: "batch_scrape", options: {} });
      for (const n of [10, 20]) await store.pushDocument(job.id, doc(n));
      await docs.drop(job.id);
      expect(await store.documents(job.id, 0, 1e6)).toEqual({ data: [], nextSkip: null });
      await store.pushDocument(job.id, doc(30));
      expect((await store.documents(job.id, 0, 1e6)).data).toEqual([doc(30)]);
    });
  });
}

/** A store on SQLite and JSONL files under `<dir>/<name>`, the layout `serve` uses. */
const fileStore = (name: string) => {
  const dataDir = join(dir, name);
  return {
    open: () => new SqliteJobStore(join(dataDir, "jobs.sqlite"), 60_000, new FsDocumentLog(join(dataDir, "documents"))),
    file: (id: string) => join(dataDir, "documents", `${id}.jsonl`),
  };
};
const lines = (...docs: Document[]) => Buffer.byteLength(docs.map((d) => `${JSON.stringify(d)}\n`).join(""));

test("unindexed bytes at the end of a file (a crash between write and index) are cut off on open", async () => {
  const { open, file } = fileStore("torn-tail");
  const first = open();
  const job = await first.create({ kind: "crawl", url: "https://e.com/", options: {} });
  const empty = await first.create({ kind: "crawl", url: "https://e.com/", options: {} });
  await first.pushDocument(job.id, doc(10));
  await first.pushDocument(job.id, doc(20));
  await first.close();
  appendFileSync(file(job.id), '{"markdown":"half a docu');
  // A job whose first document was written but never indexed.
  writeFileSync(file(empty.id), `${JSON.stringify(doc(1))}\n`);

  const second = open();
  expect((await second.documents(job.id, 0, 1e6)).data).toEqual([doc(10), doc(20)]);
  expect(statSync(file(job.id)).size).toBe(lines(doc(10), doc(20)));
  expect(statSync(file(empty.id)).size).toBe(0);
  await second.pushDocument(job.id, doc(30));
  await second.pushDocument(empty.id, doc(40));
  expect((await second.documents(job.id, 0, 1e6)).data).toEqual([doc(10), doc(20), doc(30)]);
  expect((await second.documents(empty.id, 0, 1e6)).data).toEqual([doc(40)]);
  await second.close();
});

test("index rows past the end of a file are dropped, on open and on read", async () => {
  const { open, file } = fileStore("past-eof");
  const first = open();
  const a = await first.create({ kind: "crawl", url: "https://a/", options: {} });
  const b = await first.create({ kind: "crawl", url: "https://b/", options: {} });
  for (const n of [10, 20, 30]) {
    await first.pushDocument(a.id, doc(n));
    await first.pushDocument(b.id, doc(n));
  }
  await first.close();
  // The OS lost the end of a's file (mid-way through its third line) and all of b's.
  truncateSync(file(a.id), statSync(file(a.id)).size - 10);
  rmSync(file(b.id));

  const second = open();
  expect((await second.documents(a.id, 0, 1e6)).data).toEqual([doc(10), doc(20)]);
  expect(await second.documents(b.id, 0, 1e6)).toEqual({ data: [], nextSkip: null });
  // The next document takes the place of the lost one, and the file holds no leftover bytes.
  await second.pushDocument(a.id, doc(40));
  await second.pushDocument(b.id, doc(40));
  expect((await second.documents(a.id, 0, 1e6)).data).toEqual([doc(10), doc(20), doc(40)]);
  expect((await second.documents(b.id, 0, 1e6)).data).toEqual([doc(40)]);
  expect(statSync(file(a.id)).size).toBe(lines(doc(10), doc(20), doc(40)));

  // The same, discovered while reading instead of on open: paging skips nothing that is still there.
  truncateSync(file(a.id), lines(doc(10)) + 5);
  expect((await allPages(second, a.id, 1)).flat()).toEqual([doc(10)]);
  await second.close();
});

test("a whole page of a JSONL file is one read", async () => {
  const dataDir = join(dir, "one-read");
  const log = new FsDocumentLog(dataDir);
  const reads: number[] = [];
  const read = log.read.bind(log);
  log.read = (object, offset, length) => {
    reads.push(length);
    return read(object, offset, length);
  };
  const store = new SqliteJobStore(":memory:", 60_000, log);
  const job = await store.create({ kind: "batch_scrape", options: {} });
  for (const n of [10, 20, 30]) await store.pushDocument(job.id, doc(n));
  expect((await store.documents(job.id, 0, 1e6)).data).toHaveLength(3);
  expect(reads).toEqual([lines(doc(10), doc(20), doc(30))]);
  await store.close();
  expect(readdirSync(dataDir)).toEqual([`${job.id}.jsonl`]);
});

test("a database from before documents moved to files opens, without its documents", async () => {
  const dataDir = join(dir, "old-schema");
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "jobs.sqlite"), { create: true });
  db.run(`CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, url TEXT, options TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, error TEXT, result TEXT, sources TEXT,
    total INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0,
    scheduled INTEGER NOT NULL DEFAULT 0, slots INTEGER NOT NULL DEFAULT 0, doc_count INTEGER NOT NULL DEFAULT 0,
    next_slot_at INTEGER NOT NULL DEFAULT 0, robots_txt TEXT NOT NULL DEFAULT '')`);
  db.run(`CREATE TABLE documents (job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE, seq INTEGER NOT NULL,
    size INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (job_id, seq)) WITHOUT ROWID`);
  db.run(
    `INSERT INTO jobs (id, kind, status, options, created_at, expires_at, doc_count) VALUES ('j', 'crawl', 'scraping', '{}', 0, ${Date.now() + 60_000}, 1)`,
  );
  db.run(`INSERT INTO documents VALUES ('j', 0, 2, '{}')`);
  db.close();

  const store = new SqliteJobStore(join(dataDir, "jobs.sqlite"), 60_000, new MemoryDocumentLog());
  expect(await store.get("j")).toMatchObject({ status: "scraping" });
  expect((await store.documents("j", 0, 1e6)).data).toEqual([]);
  await store.pushDocument("j", doc(1));
  expect((await store.documents("j", 0, 1e6)).data).toEqual([doc(1)]);
  await store.close();
});
