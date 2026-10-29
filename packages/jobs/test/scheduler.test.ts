import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { JobScheduler, MemoryTaskQueue, pageLimits, type Task, WEBHOOK_CONCURRENCY } from "@searxng-js/sex-jobs";

describe("pageLimits", () => {
  test("delay forces one page at a time with a cooldown", () => {
    assert.deepEqual(pageLimits({ delay: 2 }), { concurrency: 1, cooldownMs: 2000 });
    assert.deepEqual(pageLimits({ delay: 0, maxConcurrency: 3 }), { concurrency: 3, cooldownMs: 0 });
    assert.deepEqual(pageLimits({}), { concurrency: undefined, cooldownMs: 0 });
  });
});

describe("JobScheduler", () => {
  test("page tasks wait in their job's lane, capped at maxConcurrency", async () => {
    const queue = new MemoryTaskQueue({ concurrency: 8 });
    const scheduler = new JobScheduler(queue);
    let running = 0;
    let peak = 0;
    queue.startWorker(async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return undefined;
    });
    const tasks: Task[] = [1, 2, 3, 4].map((n) => ({ type: "page", jobId: "j", taskId: `t${n}`, url: `https://e.test/${n}`, depth: 0 }));
    await scheduler.add(
      tasks.map((task) => ({ task })),
      { maxConcurrency: 2 },
    );
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(peak, 2);
    await scheduler.release("j");
    await queue.close();
  });

  test("webhook deliveries share one lane capped at WEBHOOK_CONCURRENCY", async () => {
    const queue = new MemoryTaskQueue({ concurrency: 8 });
    const scheduler = new JobScheduler(queue);
    let running = 0;
    let peak = 0;
    queue.startWorker(async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return undefined;
    });
    const payload = { success: true, type: "crawl.page", id: "j", webhookId: "w", data: [], metadata: {} };
    await scheduler.add(
      [1, 2, 3, 4, 5].map((n) => ({ task: { type: "webhook" as const, jobId: `j${n}`, taskId: `w${n}`, attempt: 1, payload } })),
    );
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(peak, WEBHOOK_CONCURRENCY);
    await queue.close();
  });
});
