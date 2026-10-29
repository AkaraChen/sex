// Page time with the outbound rules on (SSRF checks, ad blocking), measured through `Engine.scrape` so the same script runs
// unchanged on any commit: run it on origin/main and on this branch, compare the tables.
//
//   bun apps/sex/scripts/bench-egress.ts --browser lightpanda --lightpanda <path> [--runs 30] [--label main]
//   bun apps/sex/scripts/bench-egress.ts --browser chrome --cdp-url http://127.0.0.1:9222 [--runs 30]
//   --raw <file> writes the samples as JSON, to pool several runs (alternate the commits to cancel drift).
//
// Pages: a local fixture with 50 and with 200 subresources (scripts; served on this machine's public address, because the
// SSRF rules refuse loopback, so the rules do their real work), and real HTTPS pages (the `--real` urls). Every page is scraped
// with the rules on (`allowPrivateNetwork: false`, `blockAds` default). Runs are interleaved (one scrape of each page per round)
// so drift hits all pages alike. Output is a Markdown table: median and p90 of the whole `Engine.scrape` call.
import { networkInterfaces } from "node:os";
import { parseArgs } from "node:util";
import { resolveConfig } from "../src/config.ts";
import { Engine } from "../src/engine/engine.ts";

const { values } = parseArgs({
  options: {
    browser: { type: "string" },
    lightpanda: { type: "string" },
    "cdp-url": { type: "string" },
    runs: { type: "string" },
    label: { type: "string" },
    real: { type: "string", multiple: true },
    host: { type: "string" },
    raw: { type: "string" },
  },
});
const runs = Number(values.runs ?? 30);
const REAL = values.real?.length
  ? values.real
  : ["https://example.com/", "https://en.wikipedia.org/wiki/Web_scraping", "https://news.ycombinator.com/"];

/** An address of this machine that the SSRF rules consider public (a global unicast one). */
function publicAddress(): string {
  if (values.host) return values.host;
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const [p, q] = a.address.split(".").map(Number) as [number, number];
      const isPrivate =
        p === 10 ||
        p === 127 ||
        (p === 172 && q >= 16 && q < 32) ||
        (p === 192 && q === 168) ||
        (p === 169 && q === 254) ||
        (p === 100 && q >= 64 && q < 128);
      if (!isPrivate) return a.address;
    }
  }
  throw new Error("this machine has no public IPv4 address; pass --host <address the SSRF rules accept>");
}

const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] as number;
const ms = (n: number) => `${n.toFixed(1)} ms`;

const host = publicAddress();
let hits = 0;
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 0,
  fetch(req) {
    hits++;
    const { pathname } = new URL(req.url);
    const m = /^\/page(\d+)$/.exec(pathname);
    if (m) {
      const n = Number(m[1]);
      const parts = ["<!doctype html><title>fixture</title>"];
      for (let i = 0; i < n - 1; i++) parts.push(`<script src="/a${i}.js"></script>`);
      parts.push("<main><h1>Fixture</h1>");
      for (let i = 0; i < 20; i++) parts.push(`<p>Paragraph ${i} of the fixture page, with some words to extract.</p>`);
      parts.push("</main>");
      return new Response(parts.join("\n"), { headers: { "content-type": "text/html" } });
    }
    return new Response("void 0;", { headers: { "content-type": "text/javascript" } });
  },
});

const base = { concurrency: 1, timeout: 45_000, searxngUrl: "http://127.0.0.1:1" };
const config =
  values.browser === "chrome"
    ? resolveConfig({ ...base, cdpUrl: values["cdp-url"] }, { allowPrivateNetwork: false }, {})
    : resolveConfig({ ...base, lightpanda: true, lightpandaPath: values.lightpanda }, { allowPrivateNetwork: false }, {});
const engine = new Engine(config);

const pages = [
  { name: "local, 50 subresources", url: `http://${host}:${server.port}/page50` },
  { name: "local, 200 subresources", url: `http://${host}:${server.port}/page200` },
  ...REAL.map((url) => ({ name: new URL(url).host + new URL(url).pathname.slice(0, 24), url })),
];
const samples = pages.map(() => [] as number[]);
const failed = pages.map(() => "");

const once = (url: string) => engine.scrape({ url, formats: ["markdown"], timeout: 40_000 });
try {
  for (const p of pages) await once(p.url).catch(() => {}); // warm up: browser start, ad list, DNS, connection setup
  for (let r = 0; r < runs; r++) {
    for (const [i, p] of pages.entries()) {
      const t0 = performance.now();
      try {
        const doc = await once(p.url);
        if (!doc.markdown) throw new Error("empty markdown");
        samples[i]?.push(performance.now() - t0);
      } catch (err) {
        failed[i] = err instanceof Error ? err.message.slice(0, 80) : String(err);
      }
    }
  }
} finally {
  await engine.close();
  server.stop(true);
}

console.log(
  `\n${values.label ?? "run"}: ${values.browser ?? "lightpanda"}, rules on (SSRF checks, blockAds), ${runs} runs per page, local pages on ${host}\n`,
);
console.log("| page | median | p90 | ok |\n|---|---|---|---|");
for (const [i, p] of pages.entries()) {
  const xs = samples[i] as number[];
  console.log(
    `| ${p.name} | ${xs.length ? ms(percentile(xs, 0.5)) : "-"} | ${xs.length ? ms(percentile(xs, 0.9)) : "-"} | ${xs.length}/${runs}${failed[i] ? ` (${failed[i]})` : ""} |`,
  );
}
if (values.raw) await Bun.write(values.raw, JSON.stringify(pages.map((p, i) => ({ name: p.name, samples: samples[i] }))));
console.error(`server saw ${hits} requests`);
process.exit(0);
