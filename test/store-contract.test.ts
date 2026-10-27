// JobStore behaviour, against SQLite in memory and in a file.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteJobStore } from "../src/core/jobs/sqlite.ts";

const dir = mkdtempSync(join(tmpdir(), "sex-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

for (const [name, path] of [
  ["memory", ":memory:"],
  ["file", join(dir, "jobs.sqlite")],
] as const) {
  describe(`job store contract (${name})`, () => {
    const store = new SqliteJobStore(path, 60_000);
    afterAll(() => store.close());

    const doc = (n: number) => ({ markdown: "x".repeat(n), metadata: { sourceURL: `https://e.com/${n}` } });

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
  });
}

test("a file store keeps jobs across a reopen and drops them after their TTL", async () => {
  const path = join(dir, "reopen.sqlite");
  const first = new SqliteJobStore(path, 60_000);
  const job = await first.create({ kind: "crawl", url: "https://e.com/", options: { limit: 3 } });
  await first.incr(job.id, "pending", 2);
  await first.pushDocument(job.id, { markdown: "kept", metadata: {} });
  await first.markSeen(job.id, ["https://e.com/"]);
  await first.close();

  const second = new SqliteJobStore(path, 60_000);
  expect(await second.get(job.id)).toMatchObject({ status: "scraping", pending: 2, options: { limit: 3 } });
  expect((await second.documents(job.id, 0, 1e6)).data).toEqual([{ markdown: "kept", metadata: {} }]);
  expect(await second.markSeen(job.id, ["https://e.com/"])).toEqual([false]);
  await second.close();

  const expired = new SqliteJobStore(path, -1);
  const gone = await expired.create({ kind: "batch_scrape", options: {} });
  await expired.close();
  // Opening the store sweeps expired jobs, together with their documents and lists.
  const third = new SqliteJobStore(path, 60_000);
  expect(await third.get(gone.id)).toBeUndefined();
  expect(await third.get(job.id)).toBeDefined();
  await third.close();
});
