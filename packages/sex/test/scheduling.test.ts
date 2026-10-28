// Per-job pacing and ordering: maxConcurrency, delay, and big jobs not starving small ones. The queue-level tests pin
// what the scheduler relies on from bunqueue (caps, cooldowns, lanes); the engine-level ones check the whole path.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/engine/engine.ts";
import { JobScheduler, pageLimits, type Task, type TaskOutcome } from "../src/engine/jobs/index.ts";
import { BunqueueTaskQueue } from "../src/engine/jobs/queue.ts";
import { runTask } from "../src/engine/tasks.ts";
import { testEngine, waitFor } from "./helpers.ts";

const page = (jobId: string, n: number): Task => ({ type: "page", jobId, taskId: `${jobId}-${n}`, url: `http://x.test/${n}`, depth: 0 });

const peak = (log: Array<{ start: number; end: number }>) =>
  Math.max(...log.map((a) => log.filter((b) => b.start < a.end && a.start < b.end).length));

describe("pageLimits", () => {
  test("delay forces one page at a time and sets the cooldown; maxConcurrency caps; neither means no job limit", () => {
    expect(pageLimits({})).toEqual({ concurrency: undefined, cooldownMs: 0 });
    expect(pageLimits({ maxConcurrency: 3 })).toEqual({ concurrency: 3, cooldownMs: 0 });
    expect(pageLimits({ delay: 0.25 })).toEqual({ concurrency: 1, cooldownMs: 250 });
    expect(pageLimits({ delay: 2, maxConcurrency: 5 })).toEqual({ concurrency: 1, cooldownMs: 2000 });
    expect(pageLimits({ delay: 0 })).toEqual({ concurrency: undefined, cooldownMs: 0 });
  });
});

describe("the queue under the scheduler", () => {
  /** Runs `tasks` through a fresh queue; each task takes `ms` and reports `outcome`. Returns start/end times per taskId. */
  async function run(
    tasks: Array<{ task: Task; options?: Record<string, unknown> }>,
    opts: { workers?: number; ms?: number; outcome?: TaskOutcome; wait?: number },
  ) {
    const queue = new BunqueueTaskQueue(":memory:", opts.workers ?? 4);
    const scheduler = new JobScheduler(queue);
    const log: Array<{ id: string; job: string; start: number; end: number }> = [];
    const t0 = Date.now();
    queue.startWorker(async (task) => {
      const entry = { id: String((task as { taskId?: string }).taskId ?? task.type), job: task.jobId, start: Date.now() - t0, end: 0 };
      log.push(entry);
      await Bun.sleep(opts.ms ?? 40);
      entry.end = Date.now() - t0;
      return opts.outcome ?? "done";
    });
    for (const { task, options } of tasks) await scheduler.add([{ task }], options);
    await waitFor(() => (log.length === tasks.length && log.every((e) => e.end) ? true : undefined), opts.wait ?? 10_000);
    await queue.close();
    return log;
  }

  test("maxConcurrency caps one job's pages, and other jobs are not held to it", async () => {
    const tasks = [
      ...Array.from({ length: 6 }, (_, i) => ({ task: page("capped", i), options: { maxConcurrency: 1 } })),
      ...Array.from({ length: 6 }, (_, i) => ({ task: page("free", i), options: {} })),
    ];
    const log = await run(tasks, {});
    expect(peak(log.filter((e) => e.job === "capped"))).toBe(1);
    expect(peak(log.filter((e) => e.job === "free"))).toBeGreaterThan(1);
  });

  test("a cap of 2 allows two at once", async () => {
    const log = await run(
      Array.from({ length: 6 }, (_, i) => ({ task: page("two", i), options: { maxConcurrency: 2 } })),
      { workers: 4 },
    );
    expect(peak(log)).toBe(2);
  });

  test("with a delay the next page starts a delay after the previous one finished", async () => {
    const log = (
      await run(
        Array.from({ length: 4 }, (_, i) => ({ task: page("slow", i), options: { delay: 0.2 } })),
        { ms: 50 },
      )
    ).sort((a, b) => a.start - b.start);
    for (let i = 1; i < log.length; i++) expect(log[i]!.start - log[i - 1]!.end).toBeGreaterThanOrEqual(190);
  });

  test("the cooldown is in place before the lane starts its next page (repeated)", async () => {
    // The cooldown is set when the broker has seen the task complete; run it many times to catch a gap in which the
    // next page of the lane could be handed out before the cooldown is in place.
    for (let round = 0; round < 8; round++) {
      const log = (
        await run(
          Array.from({ length: 3 }, (_, i) => ({ task: page(`r${round}`, i), options: { delay: 0.05 } })),
          { ms: 1 },
        )
      ).sort((a, b) => a.start - b.start);
      for (let i = 1; i < log.length; i++) expect(log[i]!.start - log[i - 1]!.end).toBeGreaterThanOrEqual(45);
    }
  });

  test("skipped tasks cost no cooldown, so a cancelled job drains at once", async () => {
    const log = await run(
      Array.from({ length: 5 }, (_, i) => ({ task: page("cancelled", i), options: { delay: 5 } })),
      { ms: 1, outcome: "skipped", wait: 2000 },
    );
    expect(log).toHaveLength(5);
  });

  test("a big job leaves room for a small one, and urgent tasks go ahead of both", async () => {
    const queue = new BunqueueTaskQueue(":memory:", 2);
    const scheduler = new JobScheduler(queue);
    const order: string[] = [];
    const release = Promise.withResolvers<void>();
    // Holds both workers until everything is queued, so the order below is the queue's choice and not arrival order.
    queue.startWorker(async (task) => {
      if (task.type === "crawl-start") order.push("urgent");
      else order.push(task.jobId);
      if (order.length <= 2) await release.promise;
      else await Bun.sleep(5);
    });
    await scheduler.add([{ task: page("blocker", 0) }]);
    await scheduler.add([{ task: page("blocker2", 0) }]);
    await waitFor(() => (order.length === 2 ? true : undefined));
    await scheduler.add(Array.from({ length: 40 }, (_, i) => ({ task: page("big", i) })));
    await scheduler.add(Array.from({ length: 3 }, (_, i) => ({ task: page("small", i) })));
    await scheduler.add([{ task: { type: "crawl-start", jobId: "crawl", taskId: "c" } }]);
    release.resolve();
    await waitFor(() => (order.length === 2 + 40 + 3 + 1 ? true : undefined));
    await queue.close();
    const rest = order.slice(2);
    expect(rest[0]).toBe("urgent");
    // The small job's three pages are done long before the big job's forty.
    const lastSmall = rest.lastIndexOf("small");
    expect(lastSmall).toBeLessThan(12);
    expect(rest.filter((j) => j === "big")).toHaveLength(40);
  });
});

describe("a lane's cap", () => {
  test("holds for tasks queued before any worker runs", async () => {
    // The cap lives in the broker with the queued tasks, not in the worker: a worker that starts later (as after a
    // restart) meets it already in place. Only `:memory:` here, since the broker is one per process.
    const queue = new BunqueueTaskQueue(":memory:", 4);
    await new JobScheduler(queue).add(
      Array.from({ length: 5 }, (_, i) => ({ task: page("early", i) })),
      { maxConcurrency: 1 },
    );
    const seen: Array<{ start: number; end: number }> = [];
    queue.startWorker(async () => {
      const entry = { start: Date.now(), end: 0 };
      seen.push(entry);
      await Bun.sleep(40);
      entry.end = Date.now();
    });
    await waitFor(() => (seen.length === 5 && seen.every((e) => e.end) ? true : undefined));
    await queue.close();
    expect(peak(seen)).toBe(1);
  });
});

describe("through the engine", () => {
  let site: ReturnType<typeof Bun.serve>;
  let inFlight: Map<string, number>;
  let peaks: Map<string, number>;
  let engine: Engine;
  let tag: (path: string) => string;
  const html = (n: string) =>
    new Response(
      `<!doctype html><html lang="en"><head><title>${n}</title></head><body><main><article><h1>${n}</h1><p>${n} content, long enough to be kept by the extractor. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p></article></main></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );

  beforeAll(() => {
    inFlight = new Map();
    peaks = new Map();
    // /<group>/<n> pages take 150 ms; the group is the first path segment.
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const { pathname } = new URL(req.url);
        const group = pathname.split("/")[1] ?? "";
        const now = (inFlight.get(group) ?? 0) + 1;
        inFlight.set(group, now);
        peaks.set(group, Math.max(peaks.get(group) ?? 0, now));
        await Bun.sleep(150);
        inFlight.set(group, now - 1);
        return html(pathname);
      },
    });
    tag = (path) => `http://127.0.0.1:${site.port}${path}`;
    engine = testEngine({ concurrency: 4 });
  });

  afterAll(async () => {
    await engine.close();
    site.stop(true);
  });

  const done = (id: string) =>
    waitFor(async () => {
      const j = await engine.jobs.store.get(id);
      return j && j.status !== "scraping" ? j : undefined;
    }, 20_000);

  test("maxConcurrency=1 never runs two pages of the job at once, and the counts come out right", async () => {
    const queued: string[] = [];
    const add = engine.jobs.queue.add.bind(engine.jobs.queue);
    engine.jobs.queue.add = async (tasks) => {
      queued.push(...tasks.map((t) => (t.task as { taskId?: string }).taskId ?? ""));
      return add(tasks);
    };
    const { job } = await engine.batchScrape({ urls: [1, 2, 3, 4, 5, 6].map((i) => tag(`/one/${i}`)), maxConcurrency: 1 });
    const finished = await done(job.id);
    engine.jobs.queue.add = add;
    expect(peaks.get("one")).toBe(1);
    expect(finished).toMatchObject({ status: "completed", total: 6, completed: 6, pending: 0 });
    // Pacing never puts a task back: every task went into the queue once, under its own id.
    expect(queued).toHaveLength(6);
    expect(new Set(queued).size).toBe(6);
  });

  test("without maxConcurrency a job uses the server-wide concurrency", async () => {
    const { job } = await engine.batchScrape({ urls: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => tag(`/wide/${i}`)) });
    await done(job.id);
    expect(peaks.get("wide")).toBeGreaterThan(1);
  });

  test("a big batch does not hold up a small job or a crawl started after it", async () => {
    const big = await engine.batchScrape({ urls: Array.from({ length: 40 }, (_, i) => tag(`/big/${i}`)) });
    await Bun.sleep(100);
    const small = await engine.batchScrape({ urls: [tag("/small/1"), tag("/small/2")] });
    const crawl = await engine.crawl({ url: tag("/crawl/"), limit: 1, sitemap: "skip", ignoreRobotsTxt: true });

    const smallDone = await done(small.job.id);
    expect(smallDone).toMatchObject({ status: "completed", completed: 2 });
    // 40 pages at 4 workers take 1.5 s; the small job needs a couple of turns, not the big job's whole run.
    expect((await engine.jobs.store.get(big.job.id))?.status).toBe("scraping");
    const crawlDone = await done(crawl.id);
    expect(crawlDone).toMatchObject({ status: "completed", completed: 1 });
    expect((await engine.jobs.store.get(big.job.id))?.status).toBe("scraping");
    const bigDone = await done(big.job.id);
    expect(bigDone).toMatchObject({ status: "completed", completed: 40, pending: 0 });
  }, 30_000);

  test("a page task delivered twice under a cap is stored and counted once", async () => {
    const { store } = engine.jobs;
    const job = await store.create({ kind: "batch_scrape", options: { maxConcurrency: 1 } });
    // Two tasks outstanding, so the job stays open after the first one settles.
    await store.incr(job.id, "pending", 2);
    await store.incr(job.id, "total", 2);
    const task: Task = { type: "page", jobId: job.id, taskId: "t1", url: tag("/dup/1"), depth: 0 };
    expect(await runTask(engine, task)).toBe("done");
    expect(await runTask(engine, task)).toBe("done");
    expect(await store.get(job.id)).toMatchObject({ completed: 1, pending: 1, status: "scraping" });
    expect((await store.documents(job.id, 0, 1e6)).data).toHaveLength(1);
    // The other task settling completes the job exactly once.
    await runTask(engine, { ...task, taskId: "t2", url: tag("/dup/2") });
    expect(await store.get(job.id)).toMatchObject({ completed: 2, pending: 0, status: "completed" });
  });

  test("the same page task queued twice under a cap (an outbox replay) is stored and settled once", async () => {
    const { store, scheduler } = engine.jobs;
    const job = await store.create({ kind: "batch_scrape", options: { maxConcurrency: 1 } });
    // A second task outstanding keeps the job open, so the replay meets a job that is still scraping.
    await store.incr(job.id, "pending", 2);
    await store.incr(job.id, "total", 2);
    const task: Task = { type: "page", jobId: job.id, taskId: "replayed", url: tag("/replay/1"), depth: 0 };
    await scheduler.add([{ task }, { task }], job.options);
    await waitFor(async () => ((await store.get(job.id))?.completed === 1 ? true : undefined));
    await Bun.sleep(600);
    expect(await store.get(job.id)).toMatchObject({ completed: 1, pending: 1, status: "scraping" });
    expect((await store.documents(job.id, 0, 1e6)).data).toHaveLength(1);
    expect(peaks.get("replay")).toBe(1);
    await runTask(engine, { ...task, taskId: "last", url: tag("/replay/2") });
    expect(await store.get(job.id)).toMatchObject({ completed: 2, pending: 0, status: "completed" });
  });

  test("a task of a finished job is skipped", async () => {
    const { store } = engine.jobs;
    const job = await store.create({ kind: "batch_scrape", options: {} });
    await store.finish(job.id, "cancelled");
    expect(await runTask(engine, { type: "page", jobId: job.id, taskId: "x", url: tag("/gone/1"), depth: 0 })).toBe("skipped");
  });
});
