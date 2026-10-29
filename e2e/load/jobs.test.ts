/**
 * Crawl, batch scrape, fairness and memory against one `sex serve` with a data dir, on a generated site
 * (`graph.ts`). The tests run in order and share the server, so the memory test sees what the jobs left behind.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { bin } from "../lib/bin.ts";
import { api, killAll, type Server, serve } from "../lib/proc.ts";
import { removeTempDirs, tempDir } from "../lib/tmp.ts";
import { type GraphSite, graphSite, pageNo } from "./graph.ts";
import { f0, f1, type JobDoc, LOAD_ENV, printResults, RssSampler, readAll, record, SCALE, sampleHealth, scaled, waitJob } from "./util.ts";

/** Documents per status page: enough hops to follow `next` many times at any scale. */
const PAGE = Math.max(10, Math.round(250 * Math.min(1, SCALE * 2)));
const CONCURRENCY = LOAD_ENV.SEX_CONCURRENCY;
let server: Server;
let rss: RssSampler;
let baseline = 0;
const sites: GraphSite[] = [];
const newSite = async (pages: number, seed = 1) => {
  const s = await graphSite(pages, seed);
  sites.push(s);
  return s;
};

beforeAll(async () => {
  server = await serve(bin("sex"), ["--data-dir", tempDir(), "--allow-private-network"], { env: LOAD_ENV });
  rss = new RssSampler(server.proc.pid);
  record(
    "settings",
    "sex serve",
    `--data-dir <tmp> --allow-private-network, SEX_CONCURRENCY=${CONCURRENCY}, SEX_EXTRACT_WORKERS=${LOAD_ENV.SEX_EXTRACT_WORKERS}`,
  );
  // Warm up: one scrape loads the extract workers, then the baseline is what an idle server holds.
  const warm = await newSite(20);
  for (let i = 1; i <= 5; i++)
    expect((await api(server.url, "/v2/scrape", { body: { url: `${warm.url}/p/${i + 3}` } })).status).toBeLessThan(600);
  await Bun.sleep(2000);
  baseline = rss.mark().main;
  record("memory", "baseline RSS after warmup (MiB)", f0(baseline));
}, 120_000);

afterAll(async () => {
  rss?.stop();
  for (const s of sites) s.stop();
  await killAll();
  removeTempDirs();
  printResults("Jobs: crawl, batch, fairness, memory");
});

const isPage = (path: string) => path === "/" || pageNo(path) !== undefined;
const pathOf = (u: string) => new URL(u).pathname;

/** Checks that a finished job's documents and errors are exactly the pages the site was asked for. */
function checkJob(
  g: GraphSite,
  docs: JobDoc[],
  pagesRead: number,
  status: any,
  errors: { errors: Array<{ url: string; code?: string }>; robotsBlocked?: string[] },
) {
  const urls = docs.map((d) => d.metadata.sourceURL);
  expect(new Set(urls).size).toBe(urls.length); // every document once, through all the `next` pages
  expect(status.status).toBe("completed");
  expect(status.completed).toBe(docs.length);
  expect(status.total).toBe(docs.length); // failed pages leave `total`
  expect(status.next).toBeNull();
  expect(pagesRead).toBeGreaterThan(1);
  // No page was fetched twice, and everything that was fetched is a document or an error, nothing else.
  const fetched = new Set<string>();
  for (const [path, n] of g.counts()) {
    if (!isPage(path)) continue;
    expect(n).toBe(1);
    fetched.add(`${g.url}${path}`);
  }
  const errorUrls = errors.errors.map((e) => e.url);
  expect(new Set(errorUrls).size).toBe(errorUrls.length);
  expect(new Set([...urls, ...errorUrls])).toEqual(fetched);
  // Failed pages are the ones whose connection broke; 404 / 500 pages with a body are documents with their status.
  for (const e of errors.errors) {
    const n = pageNo(pathOf(e.url));
    expect(n === undefined ? "?" : g.kind(n)).toBe("reset");
    expect(e.code).toBeTruthy();
  }
  for (const d of docs) {
    const n = pageNo(pathOf(d.metadata.sourceURL));
    if (n === undefined) continue;
    const kind = g.kind(n);
    expect(kind).not.toBe("reset");
    expect(d.metadata.statusCode).toBe(kind === "404" ? 404 : kind === "500" ? 500 : 200);
  }
  return { documents: docs.length, errors: errorUrls.length };
}

test(
  "crawl of 3000 pages",
  async () => {
    const limit = scaled(3000, 100);
    const g = await newSite(scaled(5000, 200));
    rss.mark();
    const health = sampleHealth(server.url);
    const t0 = performance.now();
    const start = await api(server.url, "/v2/crawl", { body: { url: `${g.url}/`, limit } });
    expect(start.status).toBe(200);
    const path = `/v2/crawl/${start.body.id}`;
    const { ms, body } = await waitJob(server.url, path, t0, 10 * 60_000);
    const h = await health.stop();
    const peak = rss.mark();
    expect(body.status).toBe("completed");

    const { docs, pages, last } = await readAll(server.url, path, PAGE);
    const errors = (await api(server.url, `${path}/errors`)).body;
    const r = checkJob(g, docs, pages, last, errors);
    // The limit counts every page tried; the graph is large enough to reach it.
    expect(r.documents + r.errors).toBe(limit);
    expect(r.errors).toBeGreaterThan(0);
    // robots.txt: nothing under /private/ was requested, and the pages that link to it show up as blocked.
    expect(g.disallowedHits()).toEqual([]);
    expect(docs.some((d) => d.metadata.sourceURL.includes("/private/"))).toBe(false);
    expect(errors.robotsBlocked.length).toBeGreaterThan(0);
    for (const u of errors.robotsBlocked) expect(pathOf(u).startsWith("/private/")).toBe(true);

    record("crawl", "limit / documents / errors", `${limit} / ${r.documents} / ${r.errors}`);
    record("crawl", "wall time (s)", f1(ms / 1000));
    record("crawl", "pages/s", f1((r.documents + r.errors) / (ms / 1000)));
    record("crawl", `status pages read via next (${PAGE} each)`, pages);
    record("crawl", "peak RSS sex / children (MiB)", `${f0(peak.main)} / ${f0(peak.children)}`);
    record("crawl", "site peak in-flight requests", g.peakInFlight());
    record("crawl", "/health p50 / p95 / max (ms)", `${f0(h.p50)} / ${f0(h.p95)} / ${f0(h.max)}`);
    expect(h.failures).toBe(0);
    expect(h.max).toBeLessThan(10_000);
    expect(ms).toBeLessThan(8 * 60_000);
    // Never more pages in flight than the setting allows (plus the start page and robots / sitemap fetches).
    expect(g.peakInFlight()).toBeLessThanOrEqual(Number(CONCURRENCY) + 4);
  },
  12 * 60_000,
);

test(
  "batch scrape of 2000 URLs",
  async () => {
    const n = scaled(2000, 100);
    const g = await newSite(n + 10, 2);
    const urls = Array.from({ length: n }, (_, i) => `${g.url}/p/${i}`);
    rss.mark();
    const health = sampleHealth(server.url);
    const t0 = performance.now();
    const start = await api(server.url, "/v2/batch/scrape", { body: { urls } });
    expect(start.status).toBe(200);
    const path = `/v2/batch/scrape/${start.body.id}`;
    const { ms } = await waitJob(server.url, path, t0, 10 * 60_000);
    const h = await health.stop();
    const peak = rss.mark();

    const { docs, pages, last } = await readAll(server.url, path, PAGE);
    const errors = (await api(server.url, `${path}/errors`)).body;
    const r = checkJob(g, docs, pages, last, errors);
    expect(r.documents + r.errors).toBe(n); // every URL is a document or an error
    expect(new Set(docs.map((d) => d.metadata.sourceURL))).toEqual(
      new Set(urls.filter((u) => g.kind(pageNo(pathOf(u)) as number) !== "reset")),
    );
    const expectedErrors = urls.filter((u) => g.kind(pageNo(pathOf(u)) as number) === "reset").length;
    expect(r.errors).toBe(expectedErrors);
    expect(g.counts().size).toBe(n);

    record("batch", "urls / documents / errors", `${n} / ${r.documents} / ${r.errors}`);
    record("batch", "wall time (s)", f1(ms / 1000));
    record("batch", "pages/s", f1(n / (ms / 1000)));
    record("batch", "peak RSS sex / children (MiB)", `${f0(peak.main)} / ${f0(peak.children)}`);
    record("batch", "/health p50 / p95 / max (ms)", `${f0(h.p50)} / ${f0(h.p95)} / ${f0(h.max)}`);
    expect(h.failures).toBe(0);
    expect(h.max).toBeLessThan(10_000);
    expect(ms).toBeLessThan(8 * 60_000);
  },
  12 * 60_000,
);

test(
  "fairness: small crawls finish long before a big one",
  async () => {
    const g = await newSite(scaled(5000, 200), 3);
    const bigLimit = scaled(2000, 200);
    const t0 = performance.now();
    const big = await api(server.url, "/v2/crawl", { body: { url: `${g.url}/`, limit: bigLimit } });
    expect(big.status).toBe(200);
    // Let the big job fill the queue first.
    await Bun.sleep(1000);
    // The comparison means nothing if the big job is already over.
    expect((await api(server.url, `/v2/crawl/${big.body.id}?limit=1`)).body.status).toBe("scraping");
    const small = await Promise.all(
      [1000, 2000, 3000, 4000].map(async (start, k) => {
        const body: Record<string, unknown> = { url: `${g.url}/p/${start}`, limit: 50, crawlEntireDomain: true };
        if (k === 3) Object.assign(body, { limit: 8, delay: 0.05 });
        const r = await api(server.url, "/v2/crawl", { body });
        expect(r.status).toBe(200);
        return { id: r.body.id as string, limit: body.limit as number, delayed: k === 3 };
      }),
    );
    const finished = new Map<string, number>();
    const jobs = [big.body.id as string, ...small.map((s) => s.id)];
    const health = sampleHealth(server.url);
    while (finished.size < jobs.length) {
      for (const id of jobs) {
        if (finished.has(id)) continue;
        const r = await api(server.url, `/v2/crawl/${id}?limit=1`);
        if (r.body.status !== "scraping") finished.set(id, performance.now() - t0);
      }
      if (performance.now() - t0 > 10 * 60_000) throw new Error("jobs did not finish");
      await Bun.sleep(100);
    }
    await health.stop();
    const bigMs = finished.get(big.body.id) as number;
    const smallMs = small.map((s) => finished.get(s.id) as number);
    for (const s of small) {
      const r = await api(server.url, `/v2/crawl/${s.id}?limit=1`);
      expect(r.body.status).toBe("completed");
      expect(r.body.completed + (await api(server.url, `/v2/crawl/${s.id}/errors`)).body.errors.length).toBe(s.limit);
    }
    const bigStatus = (await api(server.url, `/v2/crawl/${big.body.id}?limit=1`)).body;
    expect(bigStatus.status).toBe("completed");
    expect(bigStatus.completed).toBeGreaterThan(bigLimit * 0.9);

    record("fairness", "big crawl finished after (s)", f1(bigMs / 1000));
    record("fairness", "small crawls (50, 50, 50, and 8 with delay 0.05) finished after (s)", smallMs.map((m) => f1(m / 1000)).join(" / "));
    record("fairness", "slowest small / big", f1(Math.max(...smallMs) / bigMs));
    // The ordering is the point; the bound is loose enough for a slow runner.
    for (const m of smallMs) expect(m).toBeLessThan(bigMs);
    // The three plain ones take their turn at a fraction of the workers; the delayed one is slow by design.
    expect(Math.max(...smallMs.slice(0, 3))).toBeLessThan(bigMs * 0.7);
  },
  12 * 60_000,
);

test(
  "memory returns to a bound after the jobs",
  async () => {
    // A second round of the same kind of work: a leak grows with every round, a cache does not.
    const g = await newSite(scaled(2000, 200), 4);
    const before = rss.current();
    const run = async () => {
      const start = await api(server.url, "/v2/crawl", { body: { url: `${g.url}/`, limit: scaled(1000, 100), ignoreRobotsTxt: true } });
      expect(start.status).toBe(200);
      const { body } = await waitJob(server.url, `/v2/crawl/${start.body.id}`, performance.now(), 5 * 60_000);
      expect(body.status).toBe("completed");
      await readAll(server.url, `/v2/crawl/${start.body.id}`);
      const del = await api(server.url, `/v2/crawl/${start.body.id}`, { method: "DELETE" });
      expect(del.status).toBeLessThan(500);
    };
    await run();
    await Bun.sleep(10_000);
    const afterOne = rss.current();
    await run();
    await Bun.sleep(10_000);
    const afterTwo = rss.current();
    const queue = (await api(server.url, "/v2/team/queue-status")).body;
    record(
      "memory",
      "RSS before / after round 1 / after round 2, 10 s idle each (MiB)",
      `${f0(before)} / ${f0(afterOne)} / ${f0(afterTwo)}`,
    );
    record("memory", "after round 2 vs baseline (MiB)", f0(afterTwo - baseline));
    record("memory", "queue after the jobs", JSON.stringify(queue).slice(0, 200));
    // Only a clear leak fails: the second round must not keep growing, and the total stays far from a runaway.
    expect(afterTwo - afterOne).toBeLessThan(300);
    expect(afterTwo).toBeLessThan(baseline + 1500);
  },
  12 * 60_000,
);
