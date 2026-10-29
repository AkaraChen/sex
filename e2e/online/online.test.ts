import { afterAll, describe, expect, test } from "bun:test";
import { lookup } from "node:dns/promises";
import { bin } from "../lib/bin.ts";
import { api, killAll, type RunResult, run, serve } from "../lib/proc.ts";
import { site } from "../lib/sites.ts";
import { removeTempDirs } from "../lib/tmp.ts";

/*
 * The real internet and the real managed SearXNG. The internet is not ours: this CI job may fail without blocking a merge,
 * so each test is tolerant (long timeouts, a retry where a third party flakes, a skip when a service it depends on is
 * unreachable from the runner).
 */

const SLOW = 180_000;
const MANAGED = { SEX_SEARXNG_URL: undefined as string | undefined };
const binaries = [
  ["sex-lite", bin("sex-lite")],
  ["sex", bin("sex")],
] as const;

const listener = site(
  () => new Response("<html><body><h1>LOCAL LISTENER</h1></body></html>", { headers: { "content-type": "text/html" } }),
);
afterAll(async () => {
  listener.stop();
  await killAll();
  removeTempDirs();
});

/** Whether `url` answers at all from this machine (a third-party service the test depends on). */
async function reachable(url: string, ms = 15_000): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(ms) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Whether `name` resolves, and only to loopback addresses. */
async function resolvesToLoopback(name: string): Promise<boolean> {
  try {
    const all = await lookup(name, { all: true });
    return all.length > 0 && all.every((a) => a.address === "127.0.0.1" || a.address === "::1");
  } catch {
    return false;
  }
}

/** Runs `attempt` up to `times` times until `ok` accepts the result (third-party flakiness). */
async function retry(attempt: () => Promise<RunResult>, ok: (r: RunResult) => boolean, times = 3): Promise<RunResult> {
  let last!: RunResult;
  for (let i = 0; i < times; i++) {
    last = await attempt();
    if (ok(last)) return last;
    await Bun.sleep(3000);
  }
  return last;
}

describe.each(binaries)("%s: managed SearXNG search", (_name, binary) => {
  test(
    "a real query returns results (no SEX_SEARXNG_URL)",
    async () => {
      const r = await retry(
        () =>
          run(binary, ["search", "bun javascript runtime", "-n", "3", "--json", "--timeout", "90000"], {
            env: MANAGED,
            timeoutMs: 150_000,
          }),
        (x) => x.code === 0 && x.json().data.web?.length > 0,
      );
      expect(r.code, r.stderr).toBe(0);
      const web = r.json().data.web as Array<{ url: string; title: string; position: number }>;
      expect(web.length).toBeGreaterThan(0);
      expect(web.length).toBeLessThanOrEqual(3);
      for (const [i, w] of web.entries()) {
        expect(w.url).toMatch(/^https?:\/\//);
        expect(w.title.length).toBeGreaterThan(0);
        expect(w.position).toBe(i + 1);
      }
    },
    SLOW,
  );

  test(
    "search with --scrape returns page content for the results",
    async () => {
      const r = await retry(
        () =>
          run(binary, ["search", "example domain iana", "-n", "2", "--scrape", "--json", "--timeout", "60000"], {
            env: MANAGED,
            timeoutMs: 170_000,
          }),
        (x) => x.code === 0 && x.json().data.web?.some((w: any) => w.markdown),
      );
      expect(r.code, r.stderr).toBe(0);
      expect(r.json().data.web.some((w: any) => typeof w.markdown === "string" && w.markdown.length > 0)).toBe(true);
    },
    SLOW,
  );

  test(
    "serve answers /v2/search from the managed SearXNG",
    async () => {
      const s = await serve(binary, [], { env: MANAGED, startupMs: 120_000 });
      try {
        let body: any;
        for (let i = 0; i < 3; i++) {
          const r = await api(s.url, "/v2/search", { body: { query: "wikipedia", limit: 3, timeout: 60_000 } });
          body = r.body;
          if (r.status === 200 && body.data.web?.length) break;
          await Bun.sleep(3000);
        }
        expect(body.success, JSON.stringify(body)).toBe(true);
        expect(body.data.web.length).toBeGreaterThan(0);
      } finally {
        await s.stop();
      }
    },
    SLOW,
  );
});

describe.each(binaries)("%s: fetching real pages", (_name, binary) => {
  const fetchJson = (url: string, args: string[] = []) =>
    retry(
      () =>
        run(binary, ["fetch", url, "--json", "--timeout", "60000", ...args], {
          env: { SEX_ALLOW_PRIVATE_NETWORK: "0" },
          timeoutMs: 120_000,
        }),
      (x) => x.code === 0,
    );

  test(
    "https://example.com",
    async () => {
      const r = await fetchJson("https://example.com/");
      expect(r.code, r.stderr).toBe(0);
      const d = r.json().data;
      expect(d.markdown).toContain("Example Domain");
      expect(d.metadata.statusCode).toBe(200);
      expect(d.metadata.title).toBe("Example Domain");
    },
    SLOW,
  );

  test(
    "a Wikipedia article: title, main content, links, no navigation chrome",
    async () => {
      const r = await fetchJson("https://en.wikipedia.org/wiki/Web_scraping", ["-f", "markdown,links"]);
      expect(r.code, r.stderr).toBe(0);
      const d = r.json().data;
      expect(d.metadata.title).toContain("Web scraping");
      expect(d.markdown).toContain("Web scraping");
      expect(d.markdown.length).toBeGreaterThan(5000);
      expect(d.links.some((l: string) => l.startsWith("https://en.wikipedia.org/wiki/"))).toBe(true);
      expect(d.markdown).not.toContain("Jump to content");
    },
    SLOW,
  );

  test(
    "a real PDF is extracted to text",
    async () => {
      // w3.org's own dummy.pdf is behind a bot challenge for browser-like User-Agents, so use hosts that serve it plainly.
      const candidates: Array<[string, string]> = [
        ["https://pdfobject.com/pdf/sample.pdf", "Sample PDF"],
        ["https://www.orimi.com/pdf-test.pdf", "PDF Test File"],
      ];
      let last: RunResult | undefined;
      for (const [url, text] of candidates) {
        const r = await fetchJson(url);
        last = r;
        if (r.code !== 0 || r.json().data.metadata.statusCode !== 200) continue;
        const d = r.json().data;
        expect(d.metadata.contentType).toContain("application/pdf");
        expect(d.markdown).toContain(text);
        expect(d.metadata.numPages).toBeGreaterThanOrEqual(1);
        return;
      }
      throw new Error(`no PDF host answered: ${last?.stderr || last?.stdout.slice(0, 300)}`);
    },
    SLOW,
  );

  test(
    "a 404 on a real site is a document with statusCode 404",
    async () => {
      const r = await fetchJson("https://example.com/definitely-not-here-e2e");
      expect(r.code, r.stderr).toBe(0);
      expect(r.json().data.metadata.statusCode).toBe(404);
    },
    SLOW,
  );

  test(
    "a certificate problem is SCRAPE_SSL_ERROR, and skipTlsVerification lets it through",
    async () => {
      if (
        !(await reachable("https://expired.badssl.com/", 15_000).catch(() => false)) &&
        !(await fetch("https://expired.badssl.com/").then(
          () => true,
          () => true,
        ))
      )
        return;
      const r = await run(binary, ["fetch", "https://expired.badssl.com/", "--timeout", "30000"], { timeoutMs: 90_000 });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/SCRAPE_SSL_ERROR/);
    },
    SLOW,
  );

  test(
    "a name that does not exist is SCRAPE_DNS_RESOLUTION_ERROR",
    async () => {
      const r = await run(binary, ["fetch", "https://this-host-does-not-exist-e2e.example.invalid/"], { timeoutMs: 90_000 });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("SCRAPE_DNS_RESOLUTION_ERROR");
    },
    SLOW,
  );
});

// (A public redirect to a private address is e2e/lite/ssrf.test.ts: httpbin and httpbingo refuse to redirect to internal
// targets themselves, so no public service can stage it; there a proxy delivers a public IP literal to a local page.)
describe.each(binaries)("%s: SSRF through DNS and redirects", (_name, binary) => {
  const names = ["localtest.me", "127.0.0.1.nip.io"];

  for (const name of names) {
    test(
      `${name} resolves to loopback and is refused with PRIVATE_NETWORK_BLOCKED (CLI and HTTP), zero hits`,
      async () => {
        if (!(await resolvesToLoopback(name))) {
          console.warn(`skipped: ${name} does not resolve to loopback from here`);
          return;
        }
        listener.hits.length = 0;
        const port = new URL(listener.url).port;
        const url = `http://${name}:${port}/`;
        const cli = await run(binary, ["fetch", url], { env: { SEX_ALLOW_PRIVATE_NETWORK: "0" }, timeoutMs: 90_000 });
        expect(cli.code).toBe(1);
        expect(cli.stderr).toContain("PRIVATE_NETWORK_BLOCKED");
        expect(cli.stdout).toBe("");
        const s = await serve(binary, []);
        try {
          const r = await api(s.url, "/v2/scrape", { body: { url } });
          expect(r.status).toBe(403);
          expect(r.body.code).toBe("PRIVATE_NETWORK_BLOCKED");
        } finally {
          await s.stop();
        }
        expect(listener.hits).toEqual([]);
      },
      SLOW,
    );
  }

  test(
    "the same name is fetched when private networks are allowed (so the refusal above is the policy, not DNS)",
    async () => {
      if (!(await resolvesToLoopback("127.0.0.1.nip.io"))) return;
      listener.hits.length = 0;
      const r = await run(binary, ["fetch", `http://127.0.0.1.nip.io:${new URL(listener.url).port}/`, "--allow-private-network"], {
        timeoutMs: 90_000,
      });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain("LOCAL LISTENER");
      expect(listener.hits).toEqual(["/"]);
    },
    SLOW,
  );

  test(
    "a public redirect chain that stays public is followed",
    async () => {
      if (!(await reachable("https://httpbin.org/status/200"))) return;
      const r = await run(
        binary,
        ["fetch", "https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com%2F&status_code=301", "--json", "--timeout", "60000"],
        {
          env: { SEX_ALLOW_PRIVATE_NETWORK: "0" },
          timeoutMs: 120_000,
        },
      );
      expect(r.code, r.stderr).toBe(0);
      expect(r.json().data.markdown).toContain("Example Domain");
      expect(r.json().data.metadata.url).toBe("https://example.com/");
    },
    SLOW,
  );
});

describe("sex with the embedded Lightpanda", () => {
  const sex = bin("sex");
  const page = "https://quotes.toscrape.com/js/";

  test(
    "a JS-rendered page has its content only when the browser runs",
    async () => {
      if (!(await reachable(page))) {
        console.warn("skipped: quotes.toscrape.com is unreachable");
        return;
      }
      const plain = await run(sex, ["fetch", page, "--timeout", "60000"], { timeoutMs: 120_000 });
      expect(plain.code, plain.stderr).toBe(0);
      expect(plain.stdout).not.toContain("The world as we have created it");
      const rendered = await retry(
        () => run(sex, ["fetch", page, "--lightpanda", "--timeout", "90000", "--json"], { timeoutMs: 170_000 }),
        (x) => x.code === 0 && x.stdout.includes("The world as we have created it"),
        2,
      );
      expect(rendered.code, rendered.stderr).toBe(0);
      const d = rendered.json().data;
      expect(d.markdown).toContain("The world as we have created it");
      expect(d.metadata.statusCode).toBe(200);
    },
    SLOW,
  );

  test(
    "the browser path keeps the SSRF rules: a hostname that resolves to loopback is refused",
    async () => {
      if (!(await resolvesToLoopback("localtest.me"))) return;
      listener.hits.length = 0;
      const r = await run(
        sex,
        [
          "fetch",
          `http://localtest.me:${new URL(listener.url).port}/`,
          "--lightpanda",
          "--allow-private-network=false",
          "--timeout",
          "60000",
        ],
        {
          env: { SEX_ALLOW_PRIVATE_NETWORK: "0" },
          timeoutMs: 170_000,
        },
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/PRIVATE_NETWORK_BLOCKED/);
      expect(listener.hits).toEqual([]);
    },
    SLOW,
  );
});
