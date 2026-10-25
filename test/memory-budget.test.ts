import { expect, test } from "bun:test";
import { MemoryJobStore } from "../src/core/jobs/memory.ts";

const doc = (n: number) => ({ markdown: "x".repeat(n), metadata: {} });
const size = JSON.stringify(doc(1000)).length;

test("evicts the oldest finished jobs when stored documents exceed the budget", async () => {
  const store = new MemoryJobStore(60_000, size * 3 + 10);
  try {
    const mk = async (finish: boolean) => {
      const job = await store.create({ kind: "batch_scrape", options: {} });
      await store.pushDocument(job.id, doc(1000));
      await store.pushDocument(job.id, doc(1000));
      if (finish) await store.finish(job.id, "completed");
      return job.id;
    };
    const running = await mk(false); // 2 docs, still scraping: never evicted
    const old = await mk(true); // 4 docs total -> over budget, but `old` is still scraping while pushing
    const newer = await mk(true);

    expect(await store.get(running)).toBeDefined();
    expect(await store.get(old)).toBeUndefined();
    // The newest finished job survives until another push puts the store over budget again.
    const extra = await store.create({ kind: "batch_scrape", options: {} });
    await store.pushDocument(extra.id, doc(1000));
    expect(await store.get(newer)).toBeUndefined();
    expect((await store.documents(running, 0, 1e9)).data.length).toBe(2);
    expect((await store.documents(extra.id, 0, 1e9)).data.length).toBe(1);
  } finally {
    await store.close();
  }
});

test("a job under the budget is untouched", async () => {
  const store = new MemoryJobStore(60_000, size * 10);
  try {
    const job = await store.create({ kind: "batch_scrape", options: {} });
    await store.pushDocument(job.id, doc(1000));
    await store.finish(job.id, "completed");
    expect(await store.get(job.id)).toBeDefined();
  } finally {
    await store.close();
  }
});
