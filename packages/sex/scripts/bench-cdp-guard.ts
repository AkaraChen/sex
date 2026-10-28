// Cost of the CDP guard proxy (#52) against a real Chrome:
//
//   bun scripts/bench-cdp-guard.ts --cdp-url http://127.0.0.1:9222 [--runs 30] [--sub 50]
//
// One page with `--sub` same-origin sub-resources is scraped round-robin without the guard (private networks allowed, so the
// browser connects directly) and with it (private networks refused: every request goes through the guard proxy). The fixture
// is on loopback, which the guard refuses; a stand-in resolver validates a fixture name to 127.0.0.1 after a real
// `dns.lookup`, so the guard does the work it would do for a public name except the network round trip of the lookup itself.
// The browser's own request interception is off in both setups (`requestGuard` allows everything), so the difference is the proxy.
import { lookup } from "node:dns/promises";
import { parseArgs } from "node:util";
import { Deadline } from "@sex/core/deadline.ts";
import { resolveConfig } from "../src/config.ts";
import { BrowserPool } from "../src/engine/browser.ts";

const { values } = parseArgs({ options: { "cdp-url": { type: "string" }, runs: { type: "string" }, sub: { type: "string" } } });
if (!values["cdp-url"]) throw new Error("--cdp-url <http://127.0.0.1:9222> is required");
const runs = Number(values.runs ?? 30);
const N = Number(values.sub ?? 50);

const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/") {
      const parts = ["<!doctype html><title>fixture</title>"];
      for (let i = 0; i < N; i++) parts.push(`<script src="/a${i}.js"></script>`);
      parts.push("<main><h1>Fixture</h1><p>Some words to extract from the fixture page.</p></main>");
      return new Response(parts.join("\n"), { headers: { "content-type": "text/html" } });
    }
    return new Response("void 0;", { headers: { "content-type": "text/javascript" } });
  },
});

const config = (allowPrivateNetwork: boolean) =>
  resolveConfig({ cdpUrl: values["cdp-url"], allowPrivateNetwork, concurrency: 1 }, { allowPrivateNetwork }, {});
const setups = [
  { name: "no guard", pool: new BrowserPool(config(true)), url: `http://127.0.0.1:${server.port}/` },
  {
    name: "guard proxy",
    pool: new BrowserPool(config(false), undefined, async () => {
      await lookup("localhost", { all: true });
      return ["127.0.0.1"];
    }),
    url: `http://bench.invalid:${server.port}/`,
  },
];

const once = (s: (typeof setups)[number]) =>
  s.pool.scrape({
    url: s.url,
    deadline: Deadline.start(30_000),
    userAgent: "sex-bench",
    extract: { onlyMainContent: true, removeBase64Images: true, wantLinks: false, wantImages: false },
    requestGuard: async () => true,
  });

try {
  for (let i = 0; i < 5; i++) for (const s of setups) await once(s);
  const times = setups.map(() => [] as number[]);
  for (let r = 0; r < runs; r++) {
    for (const [i, s] of setups.entries()) {
      const t0 = performance.now();
      await once(s);
      times[i]!.push(performance.now() - t0);
    }
  }
  const requests = N + 1;
  console.log(`${requests} requests per page, ${runs} runs each`);
  for (const [i, s] of setups.entries()) {
    const t = times[i]!;
    console.log(`${s.name.padEnd(12)} median ${percentile(t, 0.5).toFixed(1)} ms  p90 ${percentile(t, 0.9).toFixed(1)} ms`);
  }
  const delta = percentile(times[1]!, 0.5) - percentile(times[0]!, 0.5);
  console.log(`guard: +${delta.toFixed(1)} ms per page, ${(delta / requests).toFixed(2)} ms per request (median)`);
} finally {
  await Promise.all(setups.map((s) => s.pool.close()));
  server.stop(true);
}
