import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config.ts";
import { Engine } from "../src/core/engine.ts";
import { MemoryTaskQueue } from "../src/core/jobs/memory.ts";
import type { Task } from "../src/core/jobs/types.ts";

describe("memory queue long delays", () => {
  test("a delay beyond the 2^31-1 ms timer limit does not fire immediately", async () => {
    const queue = new MemoryTaskQueue(1);
    const ran: Task[] = [];
    queue.startWorker(async (t) => {
      ran.push(t);
    });
    await queue.add([{ task: { type: "crawl-start", jobId: "j" }, delayMs: 2 ** 31 + 5000 }]);
    await Bun.sleep(150);
    expect(ran).toEqual([]);
    await queue.close();
  });

  test("a short delay still fires on time", async () => {
    const queue = new MemoryTaskQueue(1);
    const ran: Task[] = [];
    queue.startWorker(async (t) => {
      ran.push(t);
    });
    await queue.add([{ task: { type: "crawl-start", jobId: "j" }, delayMs: 30 }]);
    await Bun.sleep(200);
    expect(ran.length).toBe(1);
    await queue.close();
  });
});

describe("crawl start validation", () => {
  test("rejects a delay x limit that outlives the job TTL", async () => {
    const engine = new Engine(resolveConfig({}, { allowPrivateNetwork: true }, { SEX_JOB_TTL_MS: "60000" }));
    const err = await engine.crawl({ url: "http://127.0.0.1:1/", delay: 10, limit: 100 }).catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(400);
    expect((err as Error).message).toContain("job lifetime");
    await engine.close();
  });
});
