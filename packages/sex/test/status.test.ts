// Job status responses (#42): time fields, warnings, ?limit=, next, counting, errors with codes and the read-only team endpoints.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/engine/engine.ts";
import { createApp } from "../src/http/server.ts";
import { startFixtureSite, startMockLlm, testEngine, waitFor } from "./helpers.ts";

let site: ReturnType<typeof startFixtureSite>;
let llm: ReturnType<typeof startMockLlm>;
let engine: Engine;
let llmEngine: Engine;

beforeAll(() => {
  site = startFixtureSite();
  llm = startMockLlm(() => JSON.stringify({ limit: 7 }));
  engine = testEngine();
  llmEngine = testEngine({ llmModel: "m", llmBaseUrl: llm.url });
});

afterAll(async () => {
  site.stop();
  llm.stop();
  await engine.close();
  await llmEngine.close();
});

type Status = Record<string, unknown> & { data: unknown[] };
const get = async (e: Engine, path: string) => {
  const res = await createApp(e).app.request(path);
  return { status: res.status, body: (await res.json()) as Status };
};
const done = (e: Engine, path: string) =>
  waitFor(async () => {
    const { body } = await get(e, path);
    return body.status === "scraping" ? undefined : body;
  });
const post = async (e: Engine, path: string, body: unknown) => {
  const res = await createApp(e).app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown> & { id: string };
};

describe("job status", () => {
  test("carries createdAt, completedAt and duration", async () => {
    const { id } = await post(engine, "/v2/batch/scrape", { urls: [`${site.url}/docs/a`] });
    const body = await done(engine, `/v2/batch/scrape/${id}`);
    const created = Date.parse(body.createdAt as string);
    const completed = Date.parse(body.completedAt as string);
    expect(completed).toBeGreaterThanOrEqual(created);
    expect(body.duration).toBeCloseTo((completed - created) / 1000, 1);
    expect(Date.parse(body.expiresAt as string)).toBeGreaterThan(completed);
  });

  test("a running job has no completedAt, and always has a next", async () => {
    const job = await engine.crawl({ url: `${site.url}/`, delay: 5, sitemap: "skip", ignoreRobotsTxt: true });
    try {
      const { body } = await get(engine, `/v2/crawl/${job.id}`);
      expect(body.status).toBe("scraping");
      expect(body).not.toHaveProperty("completedAt");
      expect(body.duration).toBeGreaterThanOrEqual(0);
      expect(body.next).toMatch(/\/v2\/crawl\/.+\?skip=\d+$/);
    } finally {
      await engine.cancelJob(job);
    }
  });

  test("a failed job reports why", async () => {
    const job = await engine.jobs.store.create({ kind: "crawl", url: `${site.url}/`, options: {} });
    await engine.jobs.store.finish(job.id, "failed", { error: "boom" });
    const { body } = await get(engine, `/v2/crawl/${job.id}`);
    expect(body).toMatchObject({ status: "failed", error: "boom" });
    expect(body.completedAt).toBeString();
  });

  test("?limit= caps the documents and next carries on from there", async () => {
    const urls = ["/docs/a", "/docs/b", "/"].map((p) => `${site.url}${p}`);
    const { id } = await post(engine, "/v2/batch/scrape", { urls });
    const all = await done(engine, `/v2/batch/scrape/${id}`);
    expect(all.data).toHaveLength(3);
    expect(all.next).toBeNull();

    const first = (await get(engine, `/v2/batch/scrape/${id}?limit=2`)).body;
    expect(first.data).toHaveLength(2);
    expect(first.next).toEndWith(`/v2/batch/scrape/${id}?skip=2&limit=2`);
    const rest = (await get(engine, new URL(first.next as string).pathname + new URL(first.next as string).search)).body;
    expect(rest.data).toHaveLength(1);
    expect(rest.next).toBeNull();
    expect((await get(engine, `/v2/batch/scrape/${id}?limit=0`)).status).toBe(400);
  });

  test("a batch counts only the pages it stored: failed ones leave total and completed, and are listed with a code", async () => {
    const { id } = await post(engine, "/v2/batch/scrape", {
      urls: [`${site.url}/docs/a`, `${site.url}/docs/b`, "http://127.0.0.1:1/dead"],
    });
    const body = await done(engine, `/v2/batch/scrape/${id}`);
    expect(body).toMatchObject({ status: "completed", total: 2, completed: 2, creditsUsed: 2 });
    const { body: errors } = await get(engine, `/v2/batch/scrape/${id}/errors`);
    expect(errors.errors).toEqual([expect.objectContaining({ url: "http://127.0.0.1:1/dead", code: expect.any(String) })]);
  });

  test("warns when robots.txt blocked pages (pointing at /errors), and when a crawl found one result", async () => {
    const robots = await post(engine, "/v2/crawl", { url: `${site.url}/`, sitemap: "skip" });
    const blocked = await done(engine, `/v2/crawl/${robots.id}`);
    expect(blocked.warning).toContain("robots.txt");
    expect(blocked.warning).toContain(`/v2/crawl/${robots.id}/errors`);

    const lone = await post(engine, "/v2/crawl", { url: `${site.url}/docs/b`, sitemap: "skip" });
    const one = await done(engine, `/v2/crawl/${lone.id}`);
    expect(one.completed).toBe(1);
    expect(one.warning).toContain("Only 1 result(s) found");
    expect(one.warning).toContain("crawlEntireDomain=true");

    const entire = await post(engine, "/v2/crawl", { url: `${site.url}/docs/b`, sitemap: "skip", crawlEntireDomain: true, limit: 1 });
    expect((await done(engine, `/v2/crawl/${entire.id}`)).warning).toBeUndefined();

    const root = await post(engine, "/v2/crawl", { url: `${site.url}/`, sitemap: "skip", limit: 1, ignoreRobotsTxt: true });
    expect((await done(engine, `/v2/crawl/${root.id}`)).warning).toBeUndefined();
  });

  test("a prompt crawl answers with the options it was given and the ones it runs with", async () => {
    const withPrompt = await post(llmEngine, "/v2/crawl", {
      url: `${site.url}/`,
      prompt: "x",
      delay: 5,
      webhook: { url: `${site.url}/h`, headers: { a: "secret" } },
    });
    try {
      expect(withPrompt.promptGeneratedOptions).toEqual({ limit: 7 });
      expect(withPrompt.finalCrawlerOptions).toMatchObject({ limit: 7, delay: 5, webhook: { headers: { a: "[redacted]" } } });
    } finally {
      await llmEngine.cancelJob(await llmEngine.getJob(withPrompt.id, "crawl"));
    }
    const plain = await post(engine, "/v2/crawl", { url: `${site.url}/docs/a`, limit: 1, sitemap: "skip" });
    expect(plain).not.toHaveProperty("promptGeneratedOptions");
    expect(plain).not.toHaveProperty("finalCrawlerOptions");
  });
});

describe("batch URL validation", () => {
  test("invalid URLs are skipped and listed by default; ignoreInvalidURLs: false rejects the request", async () => {
    const urls = [`${site.url}/docs/a`, "not a url"];
    const started = await post(engine, "/v2/batch/scrape", { urls });
    expect(started.invalidURLs).toEqual(["not a url"]);
    expect(await post(engine, "/v2/batch/scrape", { urls: [`${site.url}/docs/a`] })).not.toHaveProperty("invalidURLs");
    const res = await createApp(engine).app.request("/v2/batch/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls, ignoreInvalidURLs: false }),
    });
    expect(res.status).toBe(400);
    const none = await createApp(engine).app.request("/v2/batch/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls: ["not a url"] }),
    });
    expect(none.status).toBe(400);
  });
});

describe("read-only endpoints", () => {
  test("/v2/crawl/ongoing is /v2/crawl/active, with created_at", async () => {
    const job = await engine.crawl({ url: `${site.url}/`, delay: 5, sitemap: "skip", ignoreRobotsTxt: true });
    try {
      const active = (await get(engine, "/v2/crawl/active")).body;
      const ongoing = (await get(engine, "/v2/crawl/ongoing")).body;
      expect(ongoing).toEqual(active);
      expect(active.crawls).toContainEqual(expect.objectContaining({ id: job.id, created_at: new Date(job.createdAt).toISOString() }));
    } finally {
      await engine.cancelJob(job);
    }
  });

  test("/v2/concurrency-check and /v2/team/queue-status read the queue and the store", async () => {
    await done(engine, `/v2/batch/scrape/${(await post(engine, "/v2/batch/scrape", { urls: [`${site.url}/docs/a`] })).id}`);
    const check = (await get(engine, "/v2/concurrency-check")).body;
    expect(check).toMatchObject({ success: true, maxConcurrency: 4 });
    const queue = (await get(engine, "/v2/team/queue-status")).body;
    const counts = await engine.jobs.queue.counts();
    expect(queue).toMatchObject({
      success: true,
      maxConcurrency: 4,
      jobsInQueue: counts.active + counts.waiting,
      activeJobsInQueue: counts.active,
      waitingJobsInQueue: counts.waiting,
    });
    expect(Date.parse(queue.mostRecentSuccess as string)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(queue.mostRecentSuccess as string)).toBe((await engine.jobs.store.lastCompletedAt()) ?? Number.NaN);
  });

  test("a running page task shows as active, and a delayed one as waiting", async () => {
    const job = await engine.crawl({ url: `${site.url}/`, delay: 30, sitemap: "skip", ignoreRobotsTxt: true, limit: 5 });
    try {
      await waitFor(async () => ((await get(engine, `/v2/crawl/${job.id}`)).body.completed === 1 ? true : undefined));
      // The first page is done; the lane cools down for 30 s with the rest of its pages waiting.
      const { body } = await get(engine, "/v2/team/queue-status");
      expect(body.waitingJobsInQueue).toBeGreaterThanOrEqual(1);
    } finally {
      await engine.cancelJob(job);
    }
  });
});
