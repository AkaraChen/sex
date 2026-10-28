// Each task settles its job's pending count at most once, and every task settles even when its handler fails early.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/engine/engine.ts";
import type { JobRecord, Task, TaskQueue } from "../src/engine/jobs/index.ts";
import { runTask } from "../src/engine/tasks.ts";
import { testEngine, waitFor } from "./helpers.ts";

const paragraphs = Array.from(
  { length: 4 },
  (_, i) => `<p>Paragraph ${i + 1} about settlement. ${"Lorem ipsum dolor sit amet. ".repeat(8)}</p>`,
).join("");

function startSite() {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (new URL(req.url).pathname === "/hub/") {
        return new Response(
          `<!doctype html><html lang="en"><head><title>Hub</title></head><body><main><article><h1>Hub</h1>${paragraphs}<p><a href="/hub/page">Page</a></p></article></main></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (new URL(req.url).pathname === "/hub/old") return Response.redirect(new URL("/hub/page", req.url).href, 302);
      if (["/page", "/hub/page"].includes(new URL(req.url).pathname)) {
        return new Response(
          `<!doctype html><html lang="en"><head><title>Page</title></head><body><main><article><h1>Page</h1>${paragraphs}</article></main></body></html>`,
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** Webhook receiver that records every batch_scrape/crawl event type it gets. */
function startHookServer() {
  const types: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as { type: string };
      types.push(body.type);
      return new Response("ok");
    },
  });
  return { url: `http://127.0.0.1:${server.port}/hook`, types, stop: () => server.stop(true) };
}

/** Records every task passed to queue.add, then forwards it to the real queue. */
function recordTasks(queue: TaskQueue): Task[] {
  const recorded: Task[] = [];
  const original = queue.add.bind(queue);
  queue.add = async (tasks) => {
    recorded.push(...tasks.map((t) => t.task));
    return original(tasks);
  };
  return recorded;
}

async function finished(engine: Engine, id: string): Promise<JobRecord> {
  return waitFor(async () => {
    const j = (await engine.jobs.store.get(id)) as JobRecord;
    return j.status !== "scraping" ? j : undefined;
  });
}

describe("settle", () => {
  let engine: Engine;

  beforeAll(() => {
    engine = testEngine();
  });

  afterAll(async () => {
    await engine.jobs.close();
  });

  test("the same taskId decrements pending once; a new taskId decrements again", async () => {
    const { store } = engine.jobs;
    const job = await store.create({ kind: "batch_scrape", options: {} });
    await store.incr(job.id, "pending", 2);
    expect(await store.settle(job.id, "a")).toBe(1);
    expect(await store.settle(job.id, "a")).toBeNull();
    expect(await store.settle(job.id, "b")).toBe(0);
    expect((await store.get(job.id))?.pending).toBe(0);
  });

  test("settling an unknown job returns null", async () => {
    expect(await engine.jobs.store.settle("no-such-job", "a")).toBeNull();
  });
});

describe("settlement", () => {
  let site: ReturnType<typeof startSite>;
  let hooks: ReturnType<typeof startHookServer>;
  let engine: Engine;

  beforeAll(() => {
    site = startSite();
    hooks = startHookServer();
    engine = testEngine();
  });

  afterAll(async () => {
    site.stop();
    hooks.stop();
    await engine.jobs.close();
  });

  test("a redelivered page task does not complete the job early or twice", async () => {
    const recorded = recordTasks(engine.jobs.queue);
    const { job } = await engine.batchScrape({ urls: [`${site.url}/page`], webhook: hooks.url });
    const done = await finished(engine, job.id);
    expect(done.status).toBe("completed");

    const pageTask = recorded.find((t) => t.type === "page");
    if (!pageTask) throw new Error("no page task recorded");
    await runTask(engine, pageTask);

    const after = await engine.getJob(job.id, "batch_scrape");
    expect(after.pending).toBe(0);
    expect(after.status).toBe("completed");
    await waitFor(() => (hooks.types.length >= 1 ? true : undefined));
    await Bun.sleep(100);
    expect(hooks.types.filter((t) => t === "batch_scrape.completed")).toHaveLength(1);
  });

  test("a page task whose store.get throws still settles, so the job completes", async () => {
    const { store, queue } = engine.jobs;
    // Hold the task back from the queue and run it here, so the injected failure hits the task, not a status poll.
    const held: Task[] = [];
    const realAdd = queue.add.bind(queue);
    queue.add = async (tasks) => {
      held.push(...tasks.map((t) => t.task));
    };
    const { job } = await engine.batchScrape({ urls: [`${site.url}/page`] }).finally(() => {
      queue.add = realAdd;
    });
    const realGet = store.get.bind(store);
    let failures = 1;
    store.get = async (id: string) => {
      if (failures > 0) {
        failures--;
        throw new Error("transient store failure");
      }
      return realGet(id);
    };
    try {
      await expect(runTask(engine, held[0] as Task)).rejects.toThrow("transient store failure");
    } finally {
      store.get = realGet;
    }
    expect(failures).toBe(0);
    const done = await finished(engine, job.id);
    expect(done.status).toBe("completed");
    expect(done.pending).toBe(0);
  });

  test("a failed enqueue rolls back pending and rethrows", async () => {
    const queue = engine.jobs.queue;
    const realAdd = queue.add.bind(queue);
    queue.add = async () => {
      throw new Error("queue down");
    };
    try {
      await expect(engine.batchScrape({ urls: [`${site.url}/page`] })).rejects.toThrow("queue down");
    } finally {
      queue.add = realAdd;
    }
    const jobs = await engine.jobs.store.active("batch_scrape");
    for (const j of jobs) expect(j.pending).toBe(0);
  });
});

/**
 * A task that crashes after its side effects but before it settles is delivered again. The crash is simulated by a
 * settle that throws once; the same task then runs a second time, as the queue would after a restart.
 */
describe("redelivery", () => {
  let site: ReturnType<typeof startSite>;
  let hooks: ReturnType<typeof startHookServer>;
  let engine: Engine;

  beforeAll(() => {
    site = startSite();
    hooks = startHookServer();
    engine = testEngine();
  });

  afterAll(async () => {
    site.stop();
    hooks.stop();
    await engine.jobs.close();
  });

  /** Tasks added to the queue while `start` runs are held back instead of run; webhook deliveries are not job work and go on. */
  async function held<T>(start: () => Promise<T>): Promise<{ result: T; tasks: Task[] }> {
    const { queue } = engine.jobs;
    const realAdd = queue.add.bind(queue);
    const tasks: Task[] = [];
    queue.add = async (added) => {
      tasks.push(...added.map((t) => t.task).filter((t) => t.type !== "webhook"));
      await realAdd(added.filter((t) => t.task.type === "webhook"));
    };
    try {
      return { result: await start(), tasks };
    } finally {
      queue.add = realAdd;
    }
  }

  async function crashBeforeSettle(task: Task) {
    const { store } = engine.jobs;
    const realSettle = store.settle.bind(store);
    store.settle = async () => {
      store.settle = realSettle;
      throw new Error("crashed before settle");
    };
    try {
      await expect(runTask(engine, task)).rejects.toThrow("crashed before settle");
    } finally {
      store.settle = realSettle;
    }
  }

  const count = (type: string) => hooks.types.filter((t) => t === type).length;

  test("a batch page is stored, counted and announced once", async () => {
    const before = count("batch_scrape.page");
    const { result, tasks } = await held(() => engine.batchScrape({ urls: [`${site.url}/page`], webhook: hooks.url }));
    const page = tasks[0] as Task;
    await crashBeforeSettle(page);
    await runTask(engine, page);

    const done = await finished(engine, result.job.id);
    expect(done).toMatchObject({ status: "completed", pending: 0, completed: 1 });
    expect((await engine.jobs.store.documents(done.id, 0, 1e6)).data).toHaveLength(1);
    await waitFor(() => (count("batch_scrape.completed") >= 1 ? true : undefined));
    await Bun.sleep(100);
    expect(count("batch_scrape.page") - before).toBe(1);
  });

  test("a crawl page is stored, counted and announced once, and the crawl announces its start once", async () => {
    const pages = count("crawl.page");
    const started = count("crawl.started");
    const { result: job, tasks } = await held(() =>
      engine.crawl({ url: `${site.url}/page`, limit: 5, sitemap: "skip", webhook: hooks.url } as Parameters<Engine["crawl"]>[0]),
    );
    const start = tasks[0] as Task;
    expect(start.type).toBe("crawl-start");
    const { tasks: pageTasks } = await held(async () => {
      await crashBeforeSettle(start);
      await runTask(engine, start);
    });
    // The second run finds the start URL already seen, so the first run's page task is the only one.
    expect(pageTasks).toHaveLength(1);
    const page = pageTasks[0] as Task;
    await crashBeforeSettle(page);
    await runTask(engine, page);

    const done = await finished(engine, job.id);
    expect(done).toMatchObject({ pending: 0, completed: 1 });
    expect((await engine.jobs.store.documents(job.id, 0, 1e6)).data).toHaveLength(1);
    await waitFor(() => (count("crawl.completed") >= 1 ? true : undefined));
    await Bun.sleep(100);
    expect(count("crawl.page") - pages).toBe(1);
    expect(count("crawl.started") - started).toBe(1);
  });

  /**
   * The task dies after `schedule` recorded its pages but before they reached the queue (or `released` ran), and
   * before it settled: whatever it queued is lost, as in a crash.
   */
  async function crashBeforeQueueing(task: Task) {
    const { store, queue } = engine.jobs;
    const realAdd = queue.add.bind(queue);
    const realReleased = store.released.bind(store);
    queue.add = async () => {};
    store.released = async () => {};
    try {
      await crashBeforeSettle(task);
    } finally {
      queue.add = realAdd;
      store.released = realReleased;
    }
  }

  test("a crawl task that crashes between marking links seen and queueing them loses no page", async () => {
    const { store } = engine.jobs;
    const { result: job, tasks } = await held(() =>
      engine.crawl({ url: `${site.url}/hub/`, limit: 5, sitemap: "skip" } as Parameters<Engine["crawl"]>[0]),
    );
    const start = tasks[0] as Extract<Task, { type: "crawl-start" }>;

    // The start task crashes after scheduling the hub: it is seen and counted, but no task exists for it.
    await crashBeforeQueueing(start);
    const [lost] = await store.outbox(job.id, start.taskId as string);
    expect(lost?.url).toBe(`${site.url}/hub/`);
    expect((await store.get(job.id))?.pending).toBe(2);

    // Redelivered, it queues the hub under the taskId it was scheduled with, and schedules nothing twice.
    const { tasks: hubTasks } = await held(() => runTask(engine, start));
    expect(hubTasks).toEqual([{ type: "page", jobId: job.id, taskId: lost?.taskId, url: `${site.url}/hub/`, depth: 0 }]);
    expect(await store.outbox(job.id, start.taskId as string)).toEqual([]);
    expect(await store.get(job.id)).toMatchObject({ pending: 1, scheduled: 1, total: 1 });

    // The hub's task crashes after scheduling /page; its redelivery queues it.
    const hub = hubTasks[0] as Task;
    await crashBeforeQueueing(hub);
    const { tasks: pageTasks } = await held(() => runTask(engine, hub));
    expect(pageTasks).toHaveLength(1);
    expect(pageTasks[0]).toMatchObject({ type: "page", url: `${site.url}/hub/page`, depth: 1 });
    expect(await store.get(job.id)).toMatchObject({ pending: 1, scheduled: 2, total: 2, completed: 1 });

    await runTask(engine, pageTasks[0] as Task);
    const done = await finished(engine, job.id);
    expect(done).toMatchObject({ status: "completed", pending: 0, completed: 2, scheduled: 2 });
    expect((await store.documents(job.id, 0, 1e6)).data).toHaveLength(2);
  });

  test("a page task that crashes after claiming its redirect target still stores the page when redelivered", async () => {
    const { store } = engine.jobs;
    const { result: job, tasks } = await held(() =>
      engine.crawl({ url: `${site.url}/hub/`, limit: 5, sitemap: "skip" } as Parameters<Engine["crawl"]>[0]),
    );
    await held(() => runTask(engine, tasks[0] as Task));
    // A page task for a URL that redirects to /hub/page, in scope.
    const [old] = await store.schedule(job.id, undefined, [{ key: `${site.url}/hub/old`, url: `${site.url}/hub/old`, blocked: false }], {
      limit: 5,
      depth: 1,
    });
    const task: Task = { type: "page", jobId: job.id, taskId: old?.taskId, url: `${site.url}/hub/old`, depth: 1 };

    // The first delivery marks the target seen, then dies before the document is written.
    const realPush = store.pushDocument.bind(store);
    let reached!: () => void;
    const claimed = new Promise<void>((resolve) => (reached = resolve));
    store.pushDocument = () => {
      reached();
      return new Promise(() => {});
    };
    void runTask(engine, task);
    await claimed;
    store.pushDocument = realPush;
    expect((await store.documents(job.id, 0, 1e6)).data).toHaveLength(0);

    // Redelivered, it finds the target seen by itself, not by someone else, and stores the page.
    await held(() => runTask(engine, task));
    const docs = (await store.documents(job.id, 0, 1e6)).data;
    expect(docs.map((d) => d.metadata?.url)).toEqual([`${site.url}/hub/page`]);

    // Another task for the same URL is a duplicate of a page that is already being crawled.
    const [dup] = await store.schedule(job.id, undefined, [{ key: `${site.url}/hub/old2`, url: `${site.url}/hub/old`, blocked: false }], {
      limit: 5,
      depth: 1,
    });
    await held(() => runTask(engine, { ...task, taskId: dup?.taskId }));
    expect((await store.documents(job.id, 0, 1e6)).data).toHaveLength(1);
  });

  test("a refused queue.add gives the scheduled pages' counts back", async () => {
    const { store, queue } = engine.jobs;
    const { result: job, tasks } = await held(() =>
      engine.crawl({ url: `${site.url}/hub/`, limit: 5, sitemap: "skip" } as Parameters<Engine["crawl"]>[0]),
    );
    const realAdd = queue.add.bind(queue);
    queue.add = async () => {
      throw new Error("queue down");
    };
    try {
      await runTask(engine, tasks[0] as Task);
    } finally {
      queue.add = realAdd;
    }
    const after = await finished(engine, job.id);
    expect(after).toMatchObject({ status: "failed", pending: 0 });
    expect(await store.outbox(job.id, (tasks[0] as { taskId: string }).taskId)).toEqual([]);
  });
});
