/** Hundreds of concurrent `POST /v2/scrape` against sex and against sex-lite, with `/health` sampled during the load. */
import { afterAll, expect, test } from "bun:test";
import { bin } from "../lib/bin.ts";
import { api, killAll, type Server, serve } from "../lib/proc.ts";
import { removeTempDirs, tempDir } from "../lib/tmp.ts";
import { type GraphSite, graphSite, type Kind } from "./graph.ts";
import { f0, f1, LOAD_ENV, percentile, printResults, RssSampler, record, sampleHealth, scaled, sortedCopy } from "./util.ts";

const sites: GraphSite[] = [];
afterAll(async () => {
  for (const s of sites) s.stop();
  await killAll();
  removeTempDirs();
  printResults("Concurrent /v2/scrape");
});

/** `n` distinct pages: mostly good, some slow, some 404 / 500 pages with a body, some whose connection breaks. */
function pick(g: GraphSite, n: number) {
  const want: Array<[Kind, number]> = [
    ["ok", Math.round(n * 0.7)],
    ["slow", Math.round(n * 0.15)],
    ["404", Math.round(n * 0.04)],
    ["500", Math.round(n * 0.04)],
    ["reset", Math.round(n * 0.04)],
  ];
  const out: Array<{ i: number; kind: Kind }> = [];
  for (const [kind, count] of want) {
    let got = 0;
    for (let i = 1; i < g.pages && got < count; i++)
      if (g.kind(i) === kind) {
        out.push({ i, kind });
        got++;
      }
    expect(got).toBe(count); // the site is big enough
  }
  return out;
}

async function load(name: "sex" | "sex-lite", n: number) {
  const g = await graphSite(2500, 7);
  sites.push(g);
  const args = name === "sex" ? ["--data-dir", tempDir(), "--allow-private-network"] : ["--allow-private-network"];
  const server: Server = await serve(bin(name), args, { env: LOAD_ENV });
  const rss = new RssSampler(server.proc.pid);
  try {
    // Warm up the extract workers, then forget those requests.
    expect((await api(server.url, "/v2/scrape", { body: { url: `${g.url}/` } })).status).toBe(200);
    g.hits.length = 0;
    rss.mark();

    const reqs = pick(g, n);
    const health = sampleHealth(server.url, 50);
    const t0 = performance.now();
    const results = await Promise.all(
      reqs.map(async (r) => {
        const t = performance.now();
        const res = await api(server.url, "/v2/scrape", { body: { url: `${g.url}/p/${r.i}` } });
        return { ...r, ms: performance.now() - t, status: res.status, body: res.body };
      }),
    );
    const wall = performance.now() - t0;
    const h = await health.stop();
    const peak = rss.mark();

    // No response lost or mixed up: each answer is about the URL that was asked.
    expect(results.length).toBe(reqs.length);
    let errors = 0;
    for (const r of results) {
      if (r.kind === "reset") {
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(r.body.success).toBe(false);
        errors++;
        continue;
      }
      expect(r.status).toBe(200); // error rate 0 for good URLs (and for 404 / 500 pages that have a body)
      expect(r.body.success).toBe(true);
      expect(r.body.data.metadata.sourceURL).toBe(`${g.url}/p/${r.i}`);
      expect(r.body.data.metadata.statusCode).toBe(r.kind === "404" ? 404 : r.kind === "500" ? 500 : 200);
      expect(r.body.data.markdown).toContain(r.kind === "404" ? "Not found" : r.kind === "500" ? "Server error" : `Page ${r.i}`);
    }
    // ...and was fetched once.
    const counts = g.counts();
    expect(counts.size).toBe(reqs.length);
    for (const c of counts.values()) expect(c).toBe(1);

    const ms = sortedCopy(results.filter((r) => r.kind !== "reset").map((r) => r.ms));
    const okMs = sortedCopy(results.filter((r) => r.kind === "ok").map((r) => r.ms));
    record(name, "requests / expected errors / wall time (s)", `${n} / ${errors} / ${f1(wall / 1000)}`);
    record(name, "requests/s", f1(n / (wall / 1000)));
    record(
      name,
      "latency p50 / p95 / p99 (ms), all answered",
      `${f0(percentile(ms, 50))} / ${f0(percentile(ms, 95))} / ${f0(percentile(ms, 99))}`,
    );
    record(name, "latency p50 / p95 (ms), plain pages only", `${f0(percentile(okMs, 50))} / ${f0(percentile(okMs, 95))}`);
    record(
      name,
      "/health during load: samples / failures / p50 / p95 / max (ms)",
      `${h.n} / ${h.failures} / ${f0(h.p50)} / ${f0(h.p95)} / ${f0(h.max)}`,
    );
    record(name, "peak RSS (MiB)", f0(peak.main));
    record(name, "site peak in-flight requests", g.peakInFlight());
    // Generous bounds: the point is that nothing is lost, hangs or starves /health.
    expect(h.failures).toBe(0);
    expect(h.max).toBeLessThan(10_000);
    expect(wall).toBeLessThan(120_000);
    expect(percentile(ms, 99)).toBeLessThan(90_000);
  } finally {
    rss.stop();
    await server.stop();
  }
}

test("sex: 300 concurrent scrapes", () => load("sex", scaled(300, 50)), 5 * 60_000);
test("sex-lite: 200 concurrent scrapes", () => load("sex-lite", scaled(200, 50)), 5 * 60_000);

// BUG: a 404 (or 500) answered as text/html with a body that has no markup (or an empty body, which nginx and ASP.NET
// both send) makes extraction throw: Firecrawl returns a Document with statusCode 404; sex returns 500 EXTRACT_FAILED
// ("Cannot destructure property 'firstElementChild' from null or undefined value"). Inside a crawl the page lands in /errors.
test.failing("a 404 with a plain-text or empty text/html body is a document with statusCode 404", async () => {
  const bare = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      new Response(new URL(req.url).pathname === "/empty" ? "" : "not found", { status: 404, headers: { "content-type": "text/html" } }),
  });
  const server = await serve(bin("sex-lite"), ["--allow-private-network"], { env: LOAD_ENV });
  try {
    for (const p of ["/empty", "/text"]) {
      const r = await api(server.url, "/v2/scrape", { body: { url: `http://127.0.0.1:${bare.port}${p}` } });
      expect(r.status).toBe(200);
      expect(r.body.data.metadata.statusCode).toBe(404);
    }
  } finally {
    await server.stop();
    bare.stop(true);
  }
});
