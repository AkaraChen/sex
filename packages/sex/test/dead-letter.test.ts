// A task the queue gave up on (interrupted too many times) must not strand its job in "scraping" (#78).
// The real crash is in durability.test.ts; here the dead-letter queue is filled without one, in memory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Queue, Worker } from "bunqueue/client";
import type { Engine } from "../src/engine/engine.ts";
import type { Task, WebhookPayload } from "../src/engine/jobs/index.ts";
import { BunqueueTaskQueue } from "../src/engine/jobs/queue.ts";
import { abandonTask } from "../src/engine/tasks.ts";
import { testEngine, waitFor } from "./helpers.ts";

describe("the queue hands over the tasks in its dead-letter queue", () => {
  test("once, when the worker starts, and forgets a task only after it was handled", async () => {
    const name = `dlq-${crypto.randomUUID()}`;
    const task: Task = { type: "page", jobId: "j", taskId: "t", url: "http://x.test/", depth: 0 };
    const raw = new Queue(name, { embedded: true, dataPath: ":memory:" });
    // A job that fails its only attempt lands in the DLQ, as one that startup recovery gave up on does.
    await raw.add("page", { task }, { attempts: 1, backoff: 0 });
    const failing = new Worker(name, async () => Promise.reject(new Error("crash")), { embedded: true, dataPath: ":memory:" });
    try {
      await waitFor(async () => ((await raw.getDlqAsync()).length === 1 ? true : undefined));
    } finally {
      await failing.close();
    }

    const queue = new BunqueueTaskQueue(":memory:", 1, name);
    const seen: Task[] = [];
    let broken = true;
    try {
      queue.startWorker(
        async () => {},
        async (t) => {
          seen.push(t);
          if (broken) throw new Error("not yet");
        },
      );
      await waitFor(() => (seen.length === 1 ? true : undefined));
      // The handler threw, so the entry stays for the next start.
      expect(await raw.getDlqAsync()).toHaveLength(1);
      broken = false;

      // The next start (opened before the first queue closes: the in-memory broker goes away with the last one).
      const restarted = new BunqueueTaskQueue(":memory:", 1, name);
      try {
        restarted.startWorker(
          async () => {},
          async (t) => {
            seen.push(t);
          },
        );
        await waitFor(async () => ((await raw.getDlqAsync()).length === 0 ? true : undefined));
        expect(seen).toEqual([task, task]);
      } finally {
        await restarted.close();
      }
    } finally {
      await queue.close();
      await raw.close();
    }
  });
});

describe("abandonTask", () => {
  let engine: Engine;
  let hook: ReturnType<typeof Bun.serve>;
  const events: Array<WebhookPayload> = [];

  beforeAll(() => {
    hook = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        events.push((await req.json()) as WebhookPayload);
        return new Response("ok");
      },
    });
    engine = testEngine();
  });
  afterAll(async () => {
    hook.stop(true);
    await engine.close();
  });

  const webhook = () => ({ url: `http://127.0.0.1:${hook.port}/hook` });
  const pageTask = (jobId: string, taskId: string, url: string): Task => ({ type: "page", jobId, taskId, url, depth: 0 });

  test("a batch page is recorded as failed, taken out of the total and settled once, and announced as a failed page", async () => {
    const { store } = engine.jobs;
    const job = await store.create({ kind: "batch_scrape", options: { webhook: webhook() } });
    await store.incr(job.id, "pending", 2);
    await store.incr(job.id, "total", 2);

    await abandonTask(engine, pageTask(job.id, "t1", "http://x.test/a"));
    await abandonTask(engine, pageTask(job.id, "t1", "http://x.test/a"));
    expect(await store.get(job.id)).toMatchObject({ status: "scraping", pending: 1, total: 1, completed: 0 });
    await abandonTask(engine, pageTask(job.id, "t2", "http://x.test/b"));

    expect(await store.get(job.id)).toMatchObject({ status: "completed", pending: 0, total: 0, completed: 0 });
    expect((await store.errors(job.id)).map((e) => e.url)).toEqual(["http://x.test/a", "http://x.test/b"]);
    await waitFor(() => (events.filter((e) => e.id === job.id).length === 3 ? true : undefined));
    const mine = events.filter((e) => e.id === job.id);
    expect(mine.filter((e) => e.type === "batch_scrape.page" && !e.success)).toHaveLength(2);
    expect(mine.filter((e) => e.type === "batch_scrape.completed")).toHaveLength(1);
  });

  test("a crawl page fails without being counted as a result", async () => {
    const { store } = engine.jobs;
    const job = await store.create({ kind: "crawl", url: "http://x.test/", options: {} });
    await store.incr(job.id, "pending", 1);
    await store.incr(job.id, "total", 1);
    await abandonTask(engine, pageTask(job.id, "t1", "http://x.test/a"));
    expect(await store.get(job.id)).toMatchObject({ status: "completed", pending: 0, total: 0, completed: 0 });
    expect(await store.errors(job.id)).toHaveLength(1);
  });

  test("a page of a job that already ended only settles", async () => {
    const { store } = engine.jobs;
    const job = await store.create({ kind: "batch_scrape", options: {} });
    await store.incr(job.id, "pending", 2);
    await store.finish(job.id, "cancelled");
    await abandonTask(engine, pageTask(job.id, "t1", "http://x.test/a"));
    expect(await store.get(job.id)).toMatchObject({ status: "cancelled", pending: 1 });
    expect(await store.errors(job.id)).toHaveLength(0);
  });

  test("a crawl start or an extract fails its job and announces it", async () => {
    const { store } = engine.jobs;
    const crawl = await store.create({ kind: "crawl", url: "http://x.test/", options: { webhook: webhook() } });
    await store.incr(crawl.id, "pending", 1);
    await abandonTask(engine, { type: "crawl-start", jobId: crawl.id, taskId: "s" });
    expect(await store.get(crawl.id)).toMatchObject({ status: "failed", pending: 0 });

    const extract = await store.create({ kind: "extract", options: { webhook: webhook() } });
    await abandonTask(engine, { type: "extract", jobId: extract.id, taskId: "e" });
    expect(await store.get(extract.id)).toMatchObject({ status: "failed" });
    expect((await store.get(extract.id))?.error).toBeString();
    await waitFor(() =>
      events.some((e) => e.type === "extract.failed") && events.some((e) => e.type === "crawl.failed") ? true : undefined,
    );
  });

  test("a lost webhook delivery needs nothing", async () => {
    const job = await engine.jobs.store.create({ kind: "crawl", options: {} });
    await abandonTask(engine, {
      type: "webhook",
      jobId: job.id,
      taskId: "w",
      attempt: 2,
      payload: { success: true, type: "crawl.page", id: job.id, webhookId: "w", data: [], metadata: {} },
    });
    expect(await engine.jobs.store.get(job.id)).toMatchObject({ status: "scraping", pending: 0 });
  });
});
