// Crawl over HTTP: options, robots.txt, pagination of the status route, scheduling, cancellation, LLM prompt.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startMockLlm } from "../lib/llm.ts";
import { type ApiResponse, api, killAll, type Server } from "../lib/proc.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { kindOf, llmFlags, readAllDocs, sourceUrls, startSex, userOf, waitJob } from "./helpers.ts";
import { paths, type TreeSite, treeSite } from "./tree-site.ts";

let srv: Server;
let tree: TreeSite;
let slow: TreeSite;
let llm: ReturnType<typeof startMockLlm>;
let llmReply: () => string = () => "{}";
const llmCalls: Array<{ kind: string; user: string }> = [];

beforeAll(async () => {
  tree = treeSite();
  slow = treeSite({ delayMs: 300 });
  llm = startMockLlm((req) => {
    llmCalls.push({ kind: kindOf(req), user: userOf(req) });
    return llmReply();
  });
  srv = await startSex(llmFlags(llm));
});

afterAll(async () => {
  tree.stop();
  slow.stop();
  llm.stop();
  await killAll();
  removeTempDirs();
});

/** Starts a crawl, waits for it and returns the status, the documents and the page paths. */
async function crawl(site: TreeSite, body: Record<string, unknown>) {
  const created = await api(srv.url, "/v2/crawl", { body: { url: `${site.url}/`, ...body } });
  expect(created.status).toBe(200);
  const path = `/v2/crawl/${created.body.id}`;
  const status = await waitJob(srv, path);
  if (status.status !== "completed") throw new Error(`crawl ${JSON.stringify(body)} ended ${JSON.stringify(status).slice(0, 500)}`);
  const { docs } = await readAllDocs(srv, path);
  return { created: created.body, status, docs, got: paths(sourceUrls(docs), site.url), path };
}

describe("crawl", () => {
  test("starts a job and reports a Firecrawl-shaped status", async () => {
    const created = await api(srv.url, "/v2/crawl", { body: { url: `${tree.url}/`, limit: 5 } });
    expect(created.status).toBe(200);
    expect(created.body.success).toBe(true);
    expect(created.body.url).toBe(`${srv.url}/v2/crawl/${created.body.id}`);
    const status = await waitJob(srv, `/v2/crawl/${created.body.id}`);
    expect(status).toMatchObject({ success: true, status: "completed", next: null });
    expect(status.total).toBe(5);
    expect(status.completed).toBe(5);
    expect(status.creditsUsed).toBe(5);
    expect(new Date(status.createdAt).getTime()).toBeLessThanOrEqual(new Date(status.completedAt).getTime());
    expect(new Date(status.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(status.duration).toBeGreaterThanOrEqual(0);
    const doc = status.data[0];
    expect(doc.markdown).toContain("Page ");
    expect(doc.metadata).toMatchObject({ statusCode: 200, contentType: "text/html" });
  });

  test("honours limit", async () => {
    const r = await crawl(tree, { limit: 3, sitemap: "skip" });
    expect(r.docs).toHaveLength(3);
    expect(r.status.total).toBe(3);
    expect(new Set(r.got).size).toBe(3);
    expect(r.got).toContain("/");
  });

  test("honours maxDiscoveryDepth (start page and sitemap pages are depth 0)", async () => {
    const shallow = await crawl(tree, { maxDiscoveryDepth: 1, sitemap: "skip", ignoreRobotsTxt: true, limit: 100 });
    expect(shallow.got).toContain("/d1");
    expect(shallow.got).not.toContain("/d2");
    expect(shallow.got).toContain("/wide/");
    expect(shallow.got).not.toContain("/wide/0");
    const deeper = await crawl(tree, { maxDiscoveryDepth: 3, sitemap: "skip", limit: 100 });
    expect(deeper.got).toContain("/d3");
    expect(deeper.got).not.toContain("/d4");
    expect(deeper.got).toContain("/wide/0");
  });

  test("includePaths and excludePaths", async () => {
    const included = await crawl(tree, { includePaths: ["^/blog/"], sitemap: "skip" });
    expect(included.got).toEqual(["/blog/1", "/blog/2", "/blog/3"]);

    const excluded = await crawl(tree, { excludePaths: ["^/blog", "^/wide", "^/d\\d"], sitemap: "skip", limit: 100 });
    expect(excluded.got).toEqual(["/", "/docs/a"]);
  });

  test("sitemap: include, skip and only", async () => {
    const include = await crawl(tree, { maxDiscoveryDepth: 0, limit: 100 });
    expect(include.got).toEqual(["/", "/sm/one", "/sm/two"]);
    const skip = await crawl(tree, { maxDiscoveryDepth: 0, sitemap: "skip", limit: 100 });
    expect(skip.got).toEqual(["/"]);
    const only = await crawl(tree, { sitemap: "only", limit: 100 });
    expect(only.got).toContain("/sm/one");
    expect(only.got).toContain("/sm/two");
    expect(only.got).not.toContain("/blog/1");
    expect(only.got).not.toContain("/d1");
  });

  test("respects robots.txt and reports what it skipped; ignoreRobotsTxt crawls it", async () => {
    tree.resetStats();
    const r = await crawl(tree, { sitemap: "skip", limit: 100 });
    expect(r.got).not.toContain("/private/x");
    expect(tree.starts.map((s) => s.path)).not.toContain("/private/x");
    expect(r.status.warning).toContain("robots.txt");
    const errors = await api(srv.url, `${r.path}/errors`);
    expect(errors.status).toBe(200);
    expect(errors.body.errors).toEqual([]);
    expect(errors.body.robotsBlocked).toEqual([`${tree.url}/private/x`]);

    const ignoring = await crawl(tree, { sitemap: "skip", ignoreRobotsTxt: true, limit: 100 });
    expect(ignoring.got).toContain("/private/x");
  });

  test("a start URL outside any robots rule and links to other hosts: external links are not followed", async () => {
    const r = await crawl(tree, { sitemap: "skip", limit: 100 });
    for (const u of sourceUrls(r.docs)) expect(u.startsWith(tree.url)).toBe(true);
  });

  test("the status route pages through every document exactly once, following next", async () => {
    const created = await api(srv.url, "/v2/crawl", { body: { url: `${tree.url}/`, limit: 40, sitemap: "skip", ignoreRobotsTxt: true } });
    const path = `/v2/crawl/${created.body.id}`;
    // While it runs `next` always points on; read it with a small limit in a loop until it ends.
    const seen: string[] = [];
    let url: string | null = `${path}?limit=4`;
    let pages = 0;
    let sawLimitInNext = false;
    const deadline = Date.now() + 60_000;
    while (url) {
      const r: ApiResponse = await api(srv.url, url.replace(srv.url, ""));
      expect(r.status).toBe(200);
      expect(r.body.data.length).toBeLessThanOrEqual(4);
      seen.push(...sourceUrls(r.body.data));
      pages++;
      if (r.body.next) sawLimitInNext ||= new URL(r.body.next).searchParams.get("limit") === "4";
      if (r.body.next && r.body.data.length === 0) {
        if (Date.now() > deadline) throw new Error("crawl did not finish");
        await Bun.sleep(100);
      }
      url = r.body.next;
    }
    expect(pages).toBeGreaterThanOrEqual(8);
    expect(sawLimitInNext).toBe(true);
    expect(seen).toHaveLength(40);
    expect(new Set(seen).size).toBe(40);
    const final = await waitJob(srv, path);
    expect(final.status).toBe("completed");
    expect(final.completed).toBe(40);
  }, 120_000);

  test("delay makes pages run one at a time with a pause after each", async () => {
    slow.resetStats();
    const r = await crawl(slow, { limit: 3, sitemap: "skip", delay: 1 });
    expect(r.docs).toHaveLength(3);
    expect(slow.peak()).toBe(1);
    const times = slow.starts.map((s) => s.at);
    for (let i = 1; i < times.length; i++) expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(1000 + 300 - 100);
  }, 60_000);

  test("maxConcurrency caps the pages of one job in flight", async () => {
    slow.resetStats();
    const capped = await crawl(slow, { maxConcurrency: 2, sitemap: "skip", ignoreRobotsTxt: true, maxDiscoveryDepth: 2, limit: 14 });
    expect(capped.docs).toHaveLength(14);
    expect(slow.peak()).toBeLessThanOrEqual(2);
    expect(slow.peak()).toBeGreaterThanOrEqual(2);

    slow.resetStats();
    await crawl(slow, { sitemap: "skip", maxDiscoveryDepth: 2, limit: 14 });
    expect(slow.peak()).toBeGreaterThan(2);
  }, 90_000);

  test("scrapeOptions apply to every page", async () => {
    const r = await crawl(tree, { limit: 2, sitemap: "skip", scrapeOptions: { formats: ["links", "rawHtml"] } });
    for (const d of r.docs) {
      expect(d.markdown).toBeUndefined();
      expect(Array.isArray(d.links)).toBe(true);
      expect(d.rawHtml).toContain("<h1>");
    }
  });

  test("bad options are 400 and an unknown id is 404", async () => {
    const redos = await api(srv.url, "/v2/crawl", { body: { url: `${tree.url}/`, includePaths: ["(a+)+"] } });
    expect(redos.status).toBe(400);
    expect(redos.body.code).toBe("BAD_REQUEST");
    const noUrl = await api(srv.url, "/v2/crawl", { body: { limit: 3 } });
    expect(noUrl.status).toBe(400);
    const missing = await api(srv.url, "/v2/crawl/00000000-0000-4000-8000-000000000000");
    expect(missing.status).toBe(404);
    const missingErrors = await api(srv.url, "/v2/crawl/00000000-0000-4000-8000-000000000000/errors");
    expect(missingErrors.status).toBe(404);
    const missingDelete = await api(srv.url, "/v2/crawl/00000000-0000-4000-8000-000000000000", { method: "DELETE" });
    expect(missingDelete.status).toBe(404);
  });
});

describe("cancel", () => {
  test("DELETE stops the job, its status is cancelled and no more pages are fetched", async () => {
    slow.resetStats();
    const created = await api(srv.url, "/v2/crawl", {
      body: { url: `${slow.url}/`, limit: 100, sitemap: "skip", ignoreRobotsTxt: true, maxConcurrency: 1 },
    });
    const path = `/v2/crawl/${created.body.id}`;
    await Bun.sleep(1200);

    const active = await api(srv.url, "/v2/crawl/active");
    expect(active.status).toBe(200);
    expect(active.body.crawls.map((c: any) => c.id)).toContain(created.body.id);
    const ongoing = await api(srv.url, "/v2/crawl/ongoing");
    expect(ongoing.body.crawls.map((c: any) => c.id)).toContain(created.body.id);

    const queue = await api(srv.url, "/v2/team/queue-status");
    expect(queue.body).toMatchObject({ success: true, maxConcurrency: 8 });
    expect(queue.body.jobsInQueue).toBeGreaterThan(1);
    expect(queue.body.activeJobsInQueue).toBe(1);
    expect(queue.body.waitingJobsInQueue).toBeGreaterThan(0);
    const concurrency = await api(srv.url, "/v2/concurrency-check");
    expect(concurrency.body).toMatchObject({ success: true, concurrency: 1, maxConcurrency: 8 });

    const running = await api(srv.url, path);
    expect(running.body.status).toBe("scraping");
    expect(running.body.next).toBeTruthy();

    const cancelled = await api(srv.url, path, { method: "DELETE" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ success: true, status: "cancelled" });

    await Bun.sleep(800); // a page that was already running may finish
    const settled = slow.starts.length;
    await Bun.sleep(1500);
    expect(slow.starts.length).toBe(settled);
    const status = await api(srv.url, path);
    expect(status.body.status).toBe("cancelled");
    expect(status.body.completed).toBeLessThan(100);
    const after = await api(srv.url, "/v2/crawl/active");
    expect(after.body.crawls.map((c: any) => c.id)).not.toContain(created.body.id);

    // Cancelling again, or a finished job, is a conflict.
    const again = await api(srv.url, path, { method: "DELETE" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("JOB_FINISHED");
  }, 60_000);
});

describe("crawl with a prompt (LLM)", () => {
  test("the model's options are validated and used; the site is mapped for it first", async () => {
    llmCalls.length = 0;
    llmReply = () => JSON.stringify({ includePaths: ["^/blog/.*"], limit: 5, ignoredNonsense: true });
    const created = await api(srv.url, "/v2/crawl", { body: { url: `${tree.url}/`, prompt: "only the blog posts" } });
    expect(created.status).toBe(200);
    expect(created.body.promptGeneratedOptions).toMatchObject({ includePaths: ["^/blog/.*"], limit: 5 });
    expect(created.body.finalCrawlerOptions).toMatchObject({ includePaths: ["^/blog/.*"], limit: 5 });
    const call = llmCalls.find((c) => c.kind === "crawl");
    expect(call?.user).toContain("only the blog posts");
    expect(call?.user).toContain("<site_urls>");
    expect(call?.user).toContain(`${tree.url}/blog/1`);
    const path = `/v2/crawl/${created.body.id}`;
    const status = await waitJob(srv, path);
    const { docs } = await readAllDocs(srv, path);
    expect({ status: status.status, error: status.error, got: paths(sourceUrls(docs), tree.url) }).toEqual({
      status: "completed",
      error: undefined,
      got: ["/blog/1", "/blog/2", "/blog/3"],
    });
  });

  test("params-preview shows the options without starting a crawl", async () => {
    llmReply = () => JSON.stringify({ excludePaths: ["^/wide/"], maxDiscoveryDepth: 2 });
    tree.resetStats();
    const r = await api(srv.url, "/v2/crawl/params-preview", {
      body: { url: `${tree.url}/`, prompt: "skip the wide section, stay shallow" },
    });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(JSON.stringify(r.body.data)).toContain("^/wide/");
  });

  test("a prompt without an LLM is 501", async () => {
    const bare = await startSex();
    const r = await api(bare.url, "/v2/crawl", { body: { url: `${tree.url}/`, prompt: "x" } });
    expect(r.status).toBe(501);
    expect(r.body.code).toBe("LLM_NOT_CONFIGURED");
    await bare.stop();
  });
});
