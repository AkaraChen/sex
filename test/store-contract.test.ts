// JobStore behaviour shared by both backends. The Redis variant runs when SEX_TEST_REDIS_URL is set.
import { afterAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/core/engine.ts";
import { testEngine } from "./helpers.ts";

const backends: Array<[string, string | undefined]> = [["memory", undefined]];
if (process.env.SEX_TEST_REDIS_URL) backends.push(["redis", process.env.SEX_TEST_REDIS_URL]);

for (const [name, redisUrl] of backends) {
  describe(`job store contract (${name})`, () => {
    const engine: Engine = testEngine({ redisUrl, redisPrefix: `sex-test-contract-${Date.now()}` });
    const store = engine.jobs.store;
    afterAll(() => engine.close());

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
  });
}
