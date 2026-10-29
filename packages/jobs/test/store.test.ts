import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createDocumentLog, documentsLocation, FsDocumentLog, MemoryDocumentLog, SqliteJobStore } from "@searxng-js/sex-jobs";

const dir = mkdtempSync(join(tmpdir(), "sex-jobs-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const doc = (n: number) => ({ markdown: "x".repeat(n), metadata: { sourceURL: `https://e.test/${n}` } });

describe("SqliteJobStore", () => {
  test("a document is stored once per task and counted with it", async () => {
    const store = new SqliteJobStore(":memory:", 60_000, new MemoryDocumentLog());
    const job = await store.create({ kind: "batch_scrape", options: {} });
    assert.equal(await store.pushDocument(job.id, doc(10), "t1", true), true);
    assert.equal(await store.pushDocument(job.id, doc(10), "t1", true), false);
    assert.equal(await store.pushDocument(job.id, doc(20), "t2", true), true);
    assert.equal((await store.get(job.id))?.completed, 2);
    assert.deepEqual((await store.documents(job.id, 0, 1e6)).data, [doc(10), doc(20)]);
    await store.close();
  });

  test("settle counts down once per task and discovery is atomic", async () => {
    const store = new SqliteJobStore(":memory:", 60_000, new MemoryDocumentLog());
    const job = await store.create({ kind: "crawl", url: "https://e.test/", options: {} });
    const tasks = await store.schedule(
      job.id,
      "owner",
      [
        { key: "a", url: "https://e.test/a", blocked: false },
        { key: "b", url: "https://e.test/b", blocked: false },
        { key: "c", url: "https://e.test/c", blocked: true },
        { key: "a", url: "https://e.test/a", blocked: false },
      ],
      { limit: 10, depth: 1 },
    );
    assert.equal(tasks.length, 2);
    assert.deepEqual(await store.robotsBlocked(job.id), ["https://e.test/c"]);
    assert.deepEqual(await store.outbox(job.id, "owner"), tasks);
    const record = await store.get(job.id);
    assert.deepEqual(
      { scheduled: record?.scheduled, total: record?.total, pending: record?.pending },
      { scheduled: 2, total: 2, pending: 2 },
    );
    await store.released(
      job.id,
      tasks.map((t) => t.taskId),
      true,
    );
    assert.deepEqual(await store.outbox(job.id, "owner"), []);
    assert.equal(await store.settle(job.id, "x"), 1);
    assert.equal(await store.settle(job.id, "x"), null);
    assert.equal(await store.settle(job.id, "y"), 0);
    assert.equal(await store.finish(job.id, "completed"), true);
    assert.equal(await store.finish(job.id, "failed"), false);
    await store.close();
  });

  test("a failed page leaves the total, once", async () => {
    const store = new SqliteJobStore(":memory:", 60_000, new MemoryDocumentLog());
    const job = await store.create({ kind: "batch_scrape", options: {} });
    await store.incr(job.id, "total", 3);
    const error = { id: "e", timestamp: "2026-01-01T00:00:00Z", url: "https://e.test/", error: "nope", code: "SCRAPE_TIMEOUT" };
    assert.equal(await store.pushError(job.id, error, "t", { dropFromTotal: true }), true);
    assert.equal(await store.pushError(job.id, error, "t", { dropFromTotal: true }), false);
    assert.equal((await store.get(job.id))?.total, 2);
    assert.deepEqual(await store.errors(job.id), [error]);
    await store.close();
  });

  test("jobs and their documents survive reopening the files", async () => {
    const path = join(dir, "jobs.sqlite");
    const first = new SqliteJobStore(path, 60_000, new FsDocumentLog(join(dir, "documents")));
    const job = await first.create({ kind: "batch_scrape", options: { a: 1 } });
    await first.pushDocument(job.id, doc(5), "t1", true);
    await first.close();
    const second = new SqliteJobStore(path, 60_000, new FsDocumentLog(join(dir, "documents")));
    assert.deepEqual((await second.get(job.id))?.options, { a: 1 });
    assert.deepEqual((await second.documents(job.id, 0, 1e6)).data, [doc(5)]);
    assert.deepEqual(readdirSync(join(dir, "documents")), [`${job.id}.jsonl`]);
    await second.close();
  });

  test("a page of documents stops at the character budget but always has one", async () => {
    const store = new SqliteJobStore(":memory:", 60_000, new MemoryDocumentLog());
    const job = await store.create({ kind: "batch_scrape", options: {} });
    for (const n of [100, 100, 100]) await store.pushDocument(job.id, doc(n));
    const first = await store.documents(job.id, 0, 150);
    assert.equal(first.data.length, 1);
    assert.equal(first.nextSkip, 1);
    assert.equal((await store.documents(job.id, 0, 1)).data.length, 1);
    assert.equal((await store.documents(job.id, 1, 1e6)).nextSkip, null);
    await store.close();
  });
});

describe("document logs", () => {
  test("createDocumentLog picks files, memory or S3 and says where", () => {
    assert.equal(documentsLocation({}), "memory");
    assert.match(documentsLocation({ dataDir: "/data" }), /^file:\/\/\/data\/documents/);
    assert.equal(documentsLocation({ documentsUrl: "s3://bucket/prefix", dataDir: "/data" }), "s3://bucket/prefix");
    assert.ok(createDocumentLog({}) instanceof MemoryDocumentLog);
    assert.ok(createDocumentLog({ documentsUrl: `file://${join(dir, "other")}` }) instanceof FsDocumentLog);
  });
});
