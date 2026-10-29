// Cost of `blockAds` (#49), measured against a real Lightpanda.
//
//   bun scripts/bench-adblock.ts overhead --lightpanda <path> [--runs 30]   A: 50-subresource fixture page, three setups
//   bun scripts/bench-adblock.ts pages    --lightpanda <path> [--runs 5] [url...]   B: real ad-heavy pages, blockAds on / off
//   bun scripts/bench-adblock.ts cold                                       C: decompress + parse time and memory of the list
//
// Lightpanda: `bun scripts/lightpanda.ts <path>`. Setups are run round-robin (one scrape of each per round), so drift in the
// machine or the network hits all of them alike.
import { parseArgs } from "node:util";
import { Deadline } from "@sex/core/deadline.ts";
import { resolveConfig } from "../src/config.ts";
import { AdBlockList } from "../src/engine/adblock.ts";
import { BrowserPool } from "../src/engine/browser.ts";
import { adblockTable } from "./adblock.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { lightpanda: { type: "string" }, runs: { type: "string" } },
});
const [command, ...urls] = positionals;
const runs = Number(values.runs ?? (command === "pages" ? 5 : 30));

const median = (xs: number[]) => percentile(xs, 0.5);
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}
const ms = (n: number) => `${n.toFixed(1)} ms`;

function pool(adBlockList?: () => Promise<AdBlockList>): BrowserPool {
  if (!values.lightpanda) throw new Error("--lightpanda <path> is required");
  // Private networks are allowed so the local fixture is reachable; the cost of the egress rules is measured by bench-egress.ts.
  return new BrowserPool(
    resolveConfig({ lightpanda: true, lightpandaPath: values.lightpanda, allowPrivateNetwork: true, concurrency: 1 }),
    {
      adBlockList,
    },
  );
}

const extract = { onlyMainContent: true, removeBase64Images: true, wantLinks: false, wantImages: false } as const;
const UA = "Mozilla/5.0 (compatible; sex-bench)";

async function overhead() {
  const N = 50;
  let hits = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      hits++;
      const path = new URL(req.url).pathname;
      if (path === "/") {
        // Lightpanda fetches scripts but neither images nor stylesheets, so scripts are what makes up the 50 requests.
        const parts = [`<!doctype html><title>fixture</title>`];
        for (let i = 0; i < N - 1; i++) parts.push(`<script src="/a${i}.js"></script>`);
        parts.push("<main><h1>Fixture</h1>");
        for (let i = 0; i < 20; i++) parts.push(`<p>Paragraph ${i} of the fixture page, with some words to extract.</p>`);
        parts.push("</main>");
        return new Response(parts.join("\n"), { headers: { "content-type": "text/html" } });
      }
      if (path.endsWith(".js")) return new Response("void 0;", { headers: { "content-type": "text/javascript" } });
      if (path.endsWith(".css")) return new Response("body{margin:0}", { headers: { "content-type": "text/css" } });
      return new Response(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { "content-type": "image/png" } });
    },
  });
  const real = AdBlockList.parse(new TextDecoder().decode(Bun.zstdDecompressSync(await Bun.file((await adblockTable()).path).bytes())));
  let current = real;
  const browser = pool(async () => current);
  const url = `http://127.0.0.1:${server.port}/`;
  // `empty` is blockAds with a list that matches nothing: interception is on, the lookup finds nothing, so the difference to
  // `blockAds` is the lookup alone and the difference to `off` is interception alone (the CDP round trip plus the policy plumbing).
  const setups = [
    { name: "off (no interception)", blockAds: false, list: real },
    { name: "interception only (empty list)", blockAds: true, list: AdBlockList.empty },
    { name: "blockAds", blockAds: true, list: real },
  ];
  const times = setups.map(() => [] as number[]);
  const once = (s: (typeof setups)[number]) => {
    current = s.list;
    return browser.scrape({
      url,
      deadline: Deadline.start(30_000),
      userAgent: UA,
      extract,
      blockAds: s.blockAds,
    });
  };
  try {
    for (let i = 0; i < 5; i++) for (const s of setups) await once(s); // warm up: browser start, list load, JIT
    for (let r = 0; r < runs; r++) {
      for (const [i, s] of setups.entries()) {
        const before = hits;
        const t0 = performance.now();
        const res = await once(s);
        times[i]!.push(performance.now() - t0);
        // The fixture counts what actually reached it: the page and its subresources.
        if (r === 0)
          console.error(
            `${s.name}: ${res.extracted?.markdown.length} chars, ${res.adsBlocked} ads blocked, ${hits - before} requests reached the server`,
          );
      }
    }
  } finally {
    await browser.close();
    server.stop(true);
  }
  const base = median(times[0]!);
  console.log(`\nA: a page with ${N - 1} scripts, none on the list, ${runs} runs each (page + extraction in Lightpanda)\n`);
  console.log("| setup | median | p90 | vs off (median) |\n|---|---|---|---|");
  for (const [i, s] of setups.entries()) {
    const m = median(times[i]!);
    console.log(
      `| ${s.name} | ${ms(m)} | ${ms(percentile(times[i]!, 0.9))} | ${i === 0 ? "-" : `${(((m - base) / base) * 100).toFixed(1)}%`} |`,
    );
  }
}

const label = (url: string) => {
  const u = new URL(url);
  return `${u.host}${u.pathname.length > 1 ? u.pathname.slice(0, 26) : ""}`;
};

async function pages() {
  const targets = urls.length ? urls : [];
  if (!targets.length) throw new Error("usage: bench-adblock.ts pages --lightpanda <path> <url>...");
  const browser = pool();
  const rows: string[] = [];
  try {
    await browser.warmup();
    for (const url of targets) {
      const on = { ms: [] as number[], blocked: [] as number[], chars: [] as number[], md: "" };
      const off = { ms: [] as number[], blocked: [] as number[], chars: [] as number[], md: "" };
      let failed = "";
      for (let r = 0; r < runs && !failed; r++) {
        for (const [side, blockAds] of [
          [off, false],
          [on, true],
        ] as const) {
          const t0 = performance.now();
          try {
            const res = await browser.scrape({
              url,
              deadline: Deadline.start(45_000),
              userAgent: UA,
              extract,
              blockAds,
            });
            side.ms.push(performance.now() - t0);
            side.blocked.push(res.adsBlocked ?? 0);
            side.md = res.extracted?.markdown ?? "";
            side.chars.push(side.md.length);
          } catch (err) {
            failed = err instanceof Error ? err.message : String(err);
          }
        }
      }
      if (failed || !on.ms.length || !off.ms.length) {
        rows.push(`| ${url} | failed: ${failed.slice(0, 80)} | | | | |`);
        continue;
      }
      const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
      const m = (xs: number[]) => median(xs);
      // Same text? Compare the word sets, since ads and recommended-article widgets differ between loads anyway.
      const offWords = new Set(off.md.split(/\s+/));
      const lost = [...new Set(on.md.split(/\s+/))].filter((w) => !offWords.has(w)).length;
      rows.push(
        `| ${label(url)} | ${ms(m(off.ms))} | ${ms(m(on.ms))} | ${m(on.blocked)} | ${words(off.md)} -> ${words(on.md)} | ${lost} new words |`,
      );
      if (process.env.BENCH_DUMP) {
        await Bun.write(`${process.env.BENCH_DUMP}/${label(url).replace(/\W+/g, "_")}.off.md`, off.md);
        await Bun.write(`${process.env.BENCH_DUMP}/${label(url).replace(/\W+/g, "_")}.on.md`, on.md);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`\nB: real pages, ${runs} runs each, median\n`);
  console.log(
    "| page | blockAds off | blockAds on | blocked requests | markdown words off -> on | words only in the on run |\n|---|---|---|---|---|---|",
  );
  console.log(rows.join("\n"));
}

/** Run in a fresh process per sample by `cold` itself; prints one JSON line. */
async function coldSample() {
  const rss = () => process.memoryUsage().rss;
  const file = (await adblockTable()).path;
  const bytes = await Bun.file(file).bytes();
  Bun.gc(true);
  const r0 = rss();
  const t0 = performance.now();
  const text = new TextDecoder().decode(Bun.zstdDecompressSync(bytes));
  const t1 = performance.now();
  const list = AdBlockList.parse(text);
  const t2 = performance.now();
  Bun.gc(true);
  const r1 = rss();
  let hits = 0;
  const hosts = [
    "www.example.com",
    "cdn.static.news.example.co.uk",
    "ads.doubleclick.net",
    "a.b.c.d.e.f.example.org",
    "images.example.com",
  ];
  const q0 = performance.now();
  const Q = 200_000;
  for (let i = 0; i < Q; i++) if (list.blocks(hosts[i % hosts.length]!, "example.com")) hits++;
  const q1 = performance.now();
  console.log(
    JSON.stringify({
      decompress: t1 - t0,
      parse: t2 - t1,
      rssDeltaMiB: (r1 - r0) / 2 ** 20,
      domains: list.size,
      queryNs: ((q1 - q0) / Q) * 1e6,
      hits,
    }),
  );
}

async function cold() {
  const samples: Array<Record<string, number>> = [];
  for (let i = 0; i < Math.max(runs, 5); i++) {
    const p = Bun.spawnSync([process.execPath, import.meta.path, "cold-sample"], { stderr: "inherit" });
    samples.push(JSON.parse(p.stdout.toString()));
  }
  const med = (k: string) => median(samples.map((s) => s[k]!));
  console.log(`\nC: first use of the list (${samples.length} fresh processes, median)\n`);
  console.log("| step | value |\n|---|---|");
  console.log(`| zstd decompress | ${ms(med("decompress"))} |`);
  console.log(`| parse into Sets | ${ms(med("parse"))} |`);
  console.log(`| total | ${ms(med("decompress") + med("parse"))} |`);
  console.log(`| resident memory delta | ${med("rssDeltaMiB").toFixed(1)} MiB |`);
  console.log(`| domains | ${med("domains")} |`);
  console.log(`| lookup | ${med("queryNs").toFixed(0)} ns |`);
}

const run = { overhead, pages, cold, "cold-sample": coldSample }[command ?? ""];
if (!run) throw new Error("usage: bench-adblock.ts overhead | pages | cold");
await run();
