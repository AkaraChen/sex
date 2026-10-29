// JobStore behaviour against every DocumentLog: memory, JSONL files, and S3 when SEX_TEST_S3_URL is set
// (s3://bucket/prefix, with S3_ENDPOINT / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY / S3_REGION for Bun.S3Client).
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DocumentLog,
  type DocumentRef,
  FsDocumentLog,
  MemoryDocumentLog,
  openS3,
  S3DocumentLog,
  SqliteJobStore,
} from "@searxng-js/sex-jobs";
import type { Document } from "@searxng-js/sex-scrape";

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

const s3Url = process.env.SEX_TEST_S3_URL;
// Against S3 a test makes dozens of sequential requests; a slow CI runner's SeaweedFS needs more than bun's 5 s default.
if (s3Url) setDefaultTimeout(30_000);
/** Each run writes under its own prefix and removes it afterwards. */
const s3 = s3Url
  ? (() => {
      const url = new URL(s3Url);
      const prefix = `${url.pathname.replace(/^\/+|\/+$/g, "")}/store-contract-${crypto.randomUUID()}`.replace(/^\//, "");
      return { client: new Bun.S3Client({ bucket: url.hostname }), bucket: decodeURIComponent(url.hostname), prefix };
    })()
  : undefined;
/**
 * Wraps a log so a test can see which jobs still have readable documents (through the DocumentLog interface alone),
 * make the next drops fail, and hold appends until it releases them.
 */
function recorded(inner: DocumentLog) {
  const refs: Array<{ jobId: string; ref: DocumentRef }> = [];
  let failDrops = 0;
  let held: Promise<void> = Promise.resolve();
  const log: DocumentLog = {
    append: async (jobId, json) => {
      await held;
      const ref = await inner.append(jobId, json);
      refs.push({ jobId, ref });
      return ref;
    },
    read: (object, offset, length) => inner.read(object, offset, length),
    drop: async (jobId) => {
      if (failDrops > 0) {
        failDrops--;
        throw new Error("drop failed");
      }
      await inner.drop(jobId);
    },
    ...(inner.truncate ? { truncate: inner.truncate.bind(inner) } : {}),
  };
  return {
    log,
    /** Ids of jobs with at least one document whose bytes are still all there, sorted. */
    stored: async () => {
      const ids = new Set<string>();
      for (const { jobId, ref } of refs) {
        if ((await inner.read(ref.object, ref.offset, ref.length)).length === ref.length) ids.add(jobId);
      }
      return [...ids].sort();
    },
    failNextDrops: (n: number) => {
      failDrops = n;
    },
    holdAppends: () => {
      let release = () => {};
      held = new Promise((resolve) => (release = resolve));
      return release;
    },
  };
}

let logs = 0;
const backends: Array<[string, () => ReturnType<typeof recorded>]> = [
  ["memory", () => recorded(new MemoryDocumentLog())],
  ["file", () => recorded(new FsDocumentLog(join(dir, `docs-${logs++}`)))],
];
if (s3) backends.push(["s3", () => recorded(new S3DocumentLog(openS3({ bucket: s3.bucket }), `${s3.prefix}/${logs++}`))]);

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
      expect(await store.documentsJson(job.id, 0, 1000)).toEqual({ data: [], nextSkip: null, cursor: 0 });
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
      expect(await store.settle(job.id, "t1")).toBe(1);
      expect(await store.settle(job.id, "t1")).toBeNull();
      expect(await store.settle(job.id, "t2")).toBe(0);
      const after = await store.get(job.id);
      expect({ pending: after?.pending, completed: after?.completed }).toEqual({ pending: 0, completed: 0 });
      expect(await store.settle("missing", "t")).toBeNull();
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

    test("claimSeen, errors and robots lists are per job and ordered", async () => {
      const a = await store.create({ kind: "crawl", url: "https://a/", options: {} });
      const b = await store.create({ kind: "crawl", url: "https://b/", options: {} });
      expect([await store.claimSeen(a.id, undefined, "x"), await store.claimSeen(a.id, undefined, "y")]).toEqual([true, true]);
      expect(await store.claimSeen(a.id, undefined, "x")).toBe(false);
      expect(await store.claimSeen(b.id, undefined, "x")).toBe(true);
      // The task that marked a key seen is let through again (a redelivery); another task is not.
      expect(await store.claimSeen(a.id, "t1", "z")).toBe(true);
      expect(await store.claimSeen(a.id, "t1", "z")).toBe(true);
      expect(await store.claimSeen(a.id, "t2", "z")).toBe(false);
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
      await first.claimSeen(job.id, undefined, "https://e.com/");
      await first.close();

      const second = new SqliteJobStore(path, 60_000, log);
      expect(await second.get(job.id)).toMatchObject({ status: "scraping", pending: 2, options: { limit: 3 } });
      expect((await second.documents(job.id, 0, 1e6)).data).toEqual([{ markdown: "kept", metadata: {} }]);
      await second.pushDocument(job.id, { markdown: "more", metadata: {} });
      expect((await second.documents(job.id, 0, 1e6)).data.map((d) => d.markdown)).toEqual(["kept", "more"]);
      expect(await second.claimSeen(job.id, undefined, "https://e.com/")).toBe(false);
      await second.close();
    });

    test("the TTL sweep drops a job's documents, on open and periodically", async () => {
      const path = join(dir, `sweep-${name}.sqlite`);
      const { log, stored } = makeLog();
      const expired = new SqliteJobStore(path, -1, log);
      const onOpen = await expired.create({ kind: "batch_scrape", options: {} });
      await expired.pushDocument(onOpen.id, doc(10));
      await expired.finish(onOpen.id, "completed");
      await expired.close();
      expect(await stored()).toEqual([onOpen.id]);

      // Opening the store sweeps expired jobs, together with their documents and lists.
      const store = new SqliteJobStore(path, -1, log);
      expect(await store.get(onOpen.id)).toBeUndefined();
      const periodic = await store.create({ kind: "batch_scrape", options: {} });
      await store.pushDocument(periodic.id, doc(10));
      await store.finish(periodic.id, "failed");
      (store as unknown as { sweep(): void }).sweep();
      expect(await store.get(periodic.id)).toBeUndefined();
      await store.close();
      expect(await stored()).toEqual([]);
    });

    test("a running job is never swept, and a finished one expires counted from when it finished", async () => {
      const path = join(dir, `running-${name}.sqlite`);
      const { log, stored } = makeLog();
      const store = new SqliteJobStore(path, -1, log);
      const job = await store.create({ kind: "crawl", options: {} });
      await store.pushDocument(job.id, doc(10));
      (store as unknown as { sweep(): void }).sweep();
      expect((await store.get(job.id))?.status).toBe("scraping");
      await store.close();

      // Reopening sweeps too; the running job is still there.
      const ttl = 60_000;
      const reopened = new SqliteJobStore(path, ttl, log);
      expect((await reopened.get(job.id))?.status).toBe("scraping");
      const before = Date.now();
      await reopened.finish(job.id, "completed");
      expect((await reopened.get(job.id))?.expiresAt).toBeGreaterThanOrEqual(before + ttl);
      (reopened as unknown as { sweep(): void }).sweep();
      expect(await reopened.get(job.id)).toBeDefined();
      await reopened.close();
      expect(await stored()).toEqual([job.id]);
    });

    test("documents the store did not write are never deleted, by the sweep or on open", async () => {
      const path = join(dir, `foreign-${name}.sqlite`);
      const { log, stored } = makeLog();
      // Another sex instance, or anything else, sharing the bucket, prefix or directory.
      await log.append("not-ours", JSON.stringify(doc(5)));
      const store = new SqliteJobStore(path, -1, log);
      const job = await store.create({ kind: "batch_scrape", options: {} });
      await store.pushDocument(job.id, doc(10));
      await store.finish(job.id, "completed");
      (store as unknown as { sweep(): void }).sweep();
      await store.close();
      const reopened = new SqliteJobStore(path, -1, log);
      await reopened.close();
      expect(await stored()).toEqual(["not-ours"]);
    });

    test("a drop that failed (or never ran before a crash) is retried from its tombstone", async () => {
      const path = join(dir, `tombstone-${name}.sqlite`);
      const { log, stored, failNextDrops } = makeLog();
      const first = new SqliteJobStore(path, -1, log);
      const job = await first.create({ kind: "batch_scrape", options: {} });
      await first.pushDocument(job.id, doc(10));
      await first.finish(job.id, "completed");
      failNextDrops(1);
      (first as unknown as { sweep(): void }).sweep();
      await first.close();
      expect(await stored()).toEqual([job.id]);

      // Opening the store sweeps, and the sweep retries every tombstone.
      const second = new SqliteJobStore(path, 60_000, log);
      await second.close();
      expect(await stored()).toEqual([]);
    });

    test("a document written while its job expired is dropped as well", async () => {
      const path = join(dir, `late-${name}.sqlite`);
      const { log, stored, holdAppends } = makeLog();
      const store = new SqliteJobStore(path, -1, log);
      const job = await store.create({ kind: "batch_scrape", options: {} });
      await store.finish(job.id, "cancelled");
      const release = holdAppends();
      const pushing = store.pushDocument(job.id, doc(10));
      await Bun.sleep(5);
      (store as unknown as { sweep(): void }).sweep();
      release();
      await pushing;
      await store.close();
      expect(await stored()).toEqual([]);
    });

    test("a read leaves out documents whose bytes are missing, and keeps their index rows", async () => {
      const job = await store.create({ kind: "batch_scrape", options: {} });
      for (const n of [10, 20]) await store.pushDocument(job.id, doc(n));
      await docs.drop(job.id);
      expect(await store.documents(job.id, 0, 1e6)).toEqual({ data: [], nextSkip: null });
      await store.pushDocument(job.id, doc(30));
      expect((await store.documents(job.id, 0, 1e6)).data).toEqual([doc(30)]);
      // The missing documents still hold seqs 0 and 1, so the new one is seq 2.
      expect((await store.documents(job.id, 2, 1e6)).data).toEqual([doc(30)]);
      expect((await store.documents(job.id, 3, 1e6)).data).toEqual([]);
    });

    test("pushDocument stores a task's document once and counts it once", async () => {
      const job = await store.create({ kind: "crawl", url: "https://e.com/", options: {} });
      expect(await store.pushDocument(job.id, doc(10), "t1", true)).toBe(true);
      expect(await store.pushDocument(job.id, doc(10), "t1", true)).toBe(false);
      expect(await store.pushDocument(job.id, doc(20), "t2", true)).toBe(true);
      // Without a taskId nothing is deduplicated, and without countCompleted nothing is counted.
      expect(await store.pushDocument(job.id, doc(30))).toBe(true);
      expect(await store.pushDocument(job.id, doc(30))).toBe(true);
      expect((await store.documents(job.id, 0, 1e6)).data).toEqual([doc(10), doc(20), doc(30), doc(30)]);
      expect((await store.get(job.id))?.completed).toBe(2);
      // The same taskId in another job is a different task.
      const other = await store.create({ kind: "crawl", url: "https://e.com/", options: {} });
      expect(await store.pushDocument(other.id, doc(40), "t1")).toBe(true);
      expect(await store.pushDocument("missing", doc(1), "t1")).toBe(false);
    });

    test("deliveries of one task racing each other store one document; the extra bytes are never read", async () => {
      const job = await store.create({ kind: "crawl", url: "https://e.com/", options: {} });
      const results = await Promise.all([1, 2, 3].map((n) => store.pushDocument(job.id, doc(n), "same", true)));
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results.indexOf(true) + 1;
      await store.pushDocument(job.id, doc(50), "next", true);
      expect((await store.documents(job.id, 0, 1e6)).data).toEqual([doc(winner), doc(50)]);
      expect((await store.get(job.id))?.completed).toBe(2);
    });

    test("a redelivered task's document is not written again", async () => {
      const { log, count } = counted(makeLog().log);
      const counting = new SqliteJobStore(":memory:", 60_000, log);
      const job = await counting.create({ kind: "crawl", url: "https://e.com/", options: {} });
      await counting.pushDocument(job.id, doc(10), "t1");
      await counting.pushDocument(job.id, doc(10), "t1");
      expect(count()).toBe(1);
      await counting.close();
    });

    test("claimEffect is true once per task and effect", async () => {
      const job = await store.create({ kind: "crawl", url: "https://e.com/", options: {} });
      expect(await store.claimEffect(job.id, "t1", "started")).toBe(true);
      expect(await store.claimEffect(job.id, "t1", "started")).toBe(false);
      expect(await store.claimEffect(job.id, "t2", "started")).toBe(true);
      expect(await store.claimEffect(job.id, undefined, "started")).toBe(true);
      expect(await store.claimEffect(job.id, undefined, "started")).toBe(true);
      expect(await store.claimEffect("missing", "t1", "started")).toBe(false);
      expect(await store.claimEffect("missing", undefined, "started")).toBe(false);
    });

    test("effects of one task are independent: settle, document and error each happen once", async () => {
      const job = await store.create({ kind: "batch_scrape", options: {} });
      await store.incr(job.id, "pending", 2);
      expect(await store.pushDocument(job.id, doc(1), "t1", true)).toBe(true);
      expect(await store.pushError(job.id, { id: "1", timestamp: "t", url: "u", error: "e" }, "t1")).toBe(true);
      expect(await store.pushError(job.id, { id: "2", timestamp: "t", url: "u", error: "e" }, "t1")).toBe(false);
      expect(await store.settle(job.id, "t1")).toBe(1);
      expect(await store.settle(job.id, "t1")).toBeNull();
      expect((await store.errors(job.id)).map((e) => e.id)).toEqual(["1"]);
      expect((await store.get(job.id))?.completed).toBe(1);
    });

    test("a redelivered task counts its document in `completed` and its failure out of `total` once", async () => {
      const job = await store.create({ kind: "batch_scrape", options: {} });
      await store.incr(job.id, "total", 3);
      expect(await store.pushDocument(job.id, doc(1), "ok", true)).toBe(true);
      expect(await store.pushDocument(job.id, doc(1), "ok", true)).toBe(false);
      const failure = { id: "1", timestamp: "t", url: "u", error: "e", code: "FETCH_FAILED" };
      expect(await store.pushError(job.id, failure, "bad", { dropFromTotal: true })).toBe(true);
      expect(await store.pushError(job.id, failure, "bad", { dropFromTotal: true })).toBe(false);
      const after = await store.get(job.id);
      expect({ total: after?.total, completed: after?.completed }).toEqual({ total: 2, completed: 1 });
      expect(await store.errors(job.id)).toEqual([failure]);
    });

    test("documents() takes a document limit, and documentsJson() a cursor for a job that is still running", async () => {
      const job = await store.create({ kind: "crawl", options: {} });
      for (const n of [1, 2, 3]) await store.pushDocument(job.id, doc(n), `t${n}`);
      const first = await store.documents(job.id, 0, 1e6, 2);
      expect(first.data).toEqual([doc(1), doc(2)]);
      expect(first.nextSkip).toBe(2);
      expect((await store.documents(job.id, 2, 1e6, 2)).nextSkip).toBeNull();
      expect((await store.documentsJson(job.id, 0, 1e6)).cursor).toBe(3);
      expect((await store.documentsJson(job.id, 3, 1e6)).cursor).toBe(3);
    });

    test("finishedAt is set once the job left scraping; lastCompletedAt follows completed jobs", async () => {
      const job = await store.create({ kind: "batch_scrape", options: {} });
      expect(job.finishedAt).toBeUndefined();
      expect(await store.lastCompletedAt()).toBeUndefined();
      const before = Date.now();
      await store.finish(job.id, "completed");
      const done = await store.get(job.id);
      expect(done?.finishedAt).toBeGreaterThanOrEqual(before);
      expect(done?.finishedAt).toBeLessThanOrEqual(Date.now());
      expect(await store.lastCompletedAt()).toBe(done?.finishedAt);
    });
  });
}

/** Counts appends to a log. */
function counted(inner: DocumentLog) {
  let appends = 0;
  const log: DocumentLog = {
    append: (jobId, json) => {
      appends++;
      return inner.append(jobId, json);
    },
    read: (object, offset, length) => inner.read(object, offset, length),
    drop: (jobId) => inner.drop(jobId),
  };
  return { log, count: () => appends };
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

test("index rows past the end of a file are dropped on open; a read only leaves them out", async () => {
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

  // The file loses its tail while the store is open: reads leave those documents out but keep their rows (a page
  // each), and only the repair on the next open drops them.
  truncateSync(file(a.id), lines(doc(10)) + 5);
  expect(await allPages(second, a.id, 1)).toEqual([[doc(10)], [], []]);
  await second.close();
  const third = open();
  expect(await allPages(third, a.id, 1)).toEqual([[doc(10)]]);
  await third.pushDocument(a.id, doc(50));
  expect((await third.documents(a.id, 0, 1e6)).data).toEqual([doc(10), doc(50)]);
  expect(statSync(file(a.id)).size).toBe(lines(doc(10), doc(50)));
  await third.close();
});

test("bytes that are not a whole JSON object are left out of the page instead of breaking it", async () => {
  const { open, file } = fileStore("damaged");
  const store = open();
  const job = await store.create({ kind: "batch_scrape", options: {} });
  for (const n of [10, 20, 30]) await store.pushDocument(job.id, doc(n));
  const fd = openSync(file(job.id), "r+");
  writeSync(fd, "X", lines(doc(10)));
  closeSync(fd);
  expect((await store.documents(job.id, 0, 1e6)).data).toEqual([doc(10), doc(30)]);
  const raw = await store.documentsJson(job.id, 0, 1e6);
  expect(raw.data).toHaveLength(2);
  await store.close();
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

test.skipIf(!s3)("an S3 object missing from a page is left out and keeps its index row", async () => {
  if (!s3) return;
  const prefix = `${s3.prefix}/missing`;
  const log = new S3DocumentLog(openS3({ bucket: s3.bucket }), prefix);
  const store = new SqliteJobStore(":memory:", 60_000, log);
  const job = await store.create({ kind: "batch_scrape", options: {} });
  for (const n of [10, 20, 30]) await store.pushDocument(job.id, doc(n));
  // Object names are random, so the middle document is found by its content.
  const keys = ((await s3.client.list({ prefix: `${prefix}/${job.id}/` })).contents ?? []).map((o) => o.key);
  expect(keys).toHaveLength(3);
  const sizes = await Promise.all(
    keys.map(async (k) => [k, (JSON.parse(await s3.client.file(k).text()) as Document).markdown?.length] as const),
  );
  const middle = sizes.find(([, n]) => n === 20)?.[0] as string;
  const bytes = await s3.client.file(middle).bytes();
  await s3.client.delete(middle);
  expect(await store.documents(job.id, 0, 1e6)).toEqual({ data: [doc(10), doc(30)], nextSkip: null });
  // A wrong prefix, missing permissions or read-after-write lag look the same; the document is back with its object.
  await s3.client.write(middle, bytes);
  expect((await store.documents(job.id, 0, 1e6)).data).toEqual([doc(10), doc(20), doc(30)]);
  await store.close();
  await log.drop(job.id);
});

afterAll(async () => {
  if (!s3) return;
  // Everything this run wrote; the contract tests leave nothing behind on their own, this is a safety net.
  const keys = ((await s3.client.list({ prefix: `${s3.prefix}/` })).contents ?? []).map((o) => o.key);
  await Promise.all(keys.map((k) => s3.client.delete(k)));
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

test("a duplicate delivery's orphan bytes do not survive a restart or reach a page", async () => {
  const { open, file } = fileStore("orphan");
  const first = open();
  const job = await first.create({ kind: "crawl", url: "https://e.com/", options: {} });
  await Promise.all([first.pushDocument(job.id, doc(10), "t1"), first.pushDocument(job.id, doc(10), "t1")]);
  await first.close();
  expect(statSync(file(job.id)).size).toBe(lines(doc(10)) * 2);

  const second = open();
  expect(statSync(file(job.id)).size).toBe(lines(doc(10)));
  expect((await second.documents(job.id, 0, 1e6)).data).toEqual([doc(10)]);
  expect(await second.pushDocument(job.id, doc(10), "t1")).toBe(false);
  expect(await second.pushDocument(job.id, doc(20), "t2")).toBe(true);
  expect((await second.documents(job.id, 0, 1e6)).data).toEqual([doc(10), doc(20)]);
  await second.close();
});

test("a database from before task_effects keeps its settled tasks", async () => {
  const path = join(dir, "pre-effects.sqlite");
  const first = new SqliteJobStore(path, 60_000, new MemoryDocumentLog());
  const job = await first.create({ kind: "batch_scrape", options: {} });
  await first.incr(job.id, "pending", 2);
  await first.close();
  const raw = new Database(path);
  raw.run("DROP TABLE task_effects");
  raw.run(
    "CREATE TABLE settled (job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE, task_id TEXT NOT NULL, PRIMARY KEY (job_id, task_id)) WITHOUT ROWID",
  );
  raw.run("INSERT INTO settled VALUES (?, 'old')", [job.id]);
  raw.close();

  const second = new SqliteJobStore(path, 60_000, new MemoryDocumentLog());
  expect(await second.settle(job.id, "old")).toBeNull();
  expect(await second.settle(job.id, "new")).toBe(1);
  await second.close();
  const check = new Database(path);
  expect(check.query("SELECT 1 FROM sqlite_master WHERE name = 'settled'").get()).toBeNull();
  check.close();
});
