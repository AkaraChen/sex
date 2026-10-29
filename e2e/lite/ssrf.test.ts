import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startCountingProxy } from "@searxng-js/sex-testing";
import { bin } from "../lib/bin.ts";
import { api, killAll, run, type Server, serve } from "../lib/proc.ts";
import { html, prose, site } from "../lib/sites.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { mockSearx, pagesSite } from "./support.ts";

/*
 * Without --allow-private-network every loopback / private / link-local / metadata address must be refused with
 * PRIVATE_NETWORK_BLOCKED (403) before a connection is made. `listener` counts what actually reaches it: it must stay at zero.
 *
 * A redirect from an allowed page to a private address needs an allowed first hop, and with private networks off every local
 * page is itself private. The trick used below: SEX_PROXY_URL points at a counting proxy that delivers the public IP literal
 * 93.184.216.34 (which passes the SSRF check without DNS) to a local page that answers with the redirect. The hop that follows
 * is checked on its own, before anything is sent.
 */

const lite = bin("sex-lite");
const listener = pagesSite();
let v6: { hits: string[]; port: number; stop(): void } | undefined;
let server: Server;

beforeAll(async () => {
  server = await serve(lite);
  try {
    const hits: string[] = [];
    const s = Bun.serve({
      port: 0,
      hostname: "::1",
      fetch(req) {
        hits.push(new URL(req.url).pathname);
        return html("v6", "<main><h1>v6</h1></main>");
      },
    });
    v6 = { hits, port: s.port as number, stop: () => s.stop(true) };
  } catch {
    // No IPv6 loopback on this machine: the [::1] case still runs against the port of the v4 listener.
  }
});
afterAll(async () => {
  listener.stop();
  v6?.stop();
  await server.stop();
  await killAll();
  removeTempDirs();
});

const port = () => new URL(listener.url).port;

/** URLs that point at the listener's port in every spelling of loopback we know. */
function loopbackTargets(): Record<string, string> {
  const p = port();
  return {
    "127.0.0.1": `http://127.0.0.1:${p}/`,
    localhost: `http://localhost:${p}/`,
    "localhost.": `http://localhost.:${p}/`,
    "[::1]": `http://[::1]:${v6?.port ?? p}/`,
    "hex 0x7f000001": `http://0x7f000001:${p}/`,
    "octal 0177.0.0.1": `http://0177.0.0.1:${p}/`,
    "decimal 2130706433": `http://2130706433:${p}/`,
    "short 127.1": `http://127.1:${p}/`,
    "127.255.255.254": `http://127.255.255.254:${p}/`,
    "0 (this host)": `http://0:${p}/`,
    "0.0.0.0": `http://0.0.0.0:${p}/`,
    "[::ffff:127.0.0.1]": `http://[::ffff:127.0.0.1]:${p}/`,
    "[::]": `http://[::]:${p}/`,
    "foo.localhost": `http://foo.localhost:${p}/`,
    "userinfo trick": `http://example.com@127.0.0.1:${p}/`,
    "uppercase LOCALHOST": `http://LOCALHOST:${p}/`,
  };
}

/** Addresses that are not loopback but not public either. Nothing listens there; the point is that no connection is tried. */
const OTHER_PRIVATE: Record<string, string> = {
  "metadata 169.254.169.254": "http://169.254.169.254/latest/meta-data/",
  "link-local 169.254.1.1": "http://169.254.1.1/",
  "10.0.0.1": "http://10.0.0.1/",
  "10.255.255.255": "http://10.255.255.255/",
  "172.16.0.1": "http://172.16.0.1/",
  "172.31.255.255": "http://172.31.255.255/",
  "192.168.0.1": "http://192.168.0.1/",
  "192.168.1.1:8080": "http://192.168.1.1:8080/",
  "[fd00::1]": "http://[fd00::1]/",
  "[fd12:3456::1]": "http://[fd12:3456::1]/",
  "[fe80::1]": "http://[fe80::1]/",
  "[::ffff:169.254.169.254]": "http://[::ffff:169.254.169.254]/",
  "[::ffff:10.0.0.1]": "http://[::ffff:10.0.0.1]/",
};

const allHits = () => [...listener.hits, ...(v6?.hits ?? [])];

describe("CLI fetch with SEX_ALLOW_PRIVATE_NETWORK=0", () => {
  test("loopback in every spelling is PRIVATE_NETWORK_BLOCKED and the listener sees nothing", async () => {
    const targets = Object.entries(loopbackTargets());
    const results = await Promise.all(targets.map(([, url]) => run(lite, ["fetch", url], { env: { SEX_ALLOW_PRIVATE_NETWORK: "0" } })));
    for (const [i, r] of results.entries()) {
      const name = targets[i]![0];
      expect(r.code, name).toBe(1);
      expect(r.stdout, name).toBe("");
      expect(r.stderr, name).toContain("PRIVATE_NETWORK_BLOCKED");
    }
    expect(allHits()).toEqual([]);
  }, 120_000);

  test("private, link-local and metadata ranges are refused", async () => {
    const targets = Object.entries(OTHER_PRIVATE);
    const results = await Promise.all(targets.map(([, url]) => run(lite, ["fetch", url], { env: { SEX_ALLOW_PRIVATE_NETWORK: "0" } })));
    for (const [i, r] of results.entries()) {
      expect(r.stderr, targets[i]![0]).toContain("PRIVATE_NETWORK_BLOCKED");
      expect(r.code, targets[i]![0]).toBe(1);
      expect(r.stdout, targets[i]![0]).toBe("");
    }
  }, 120_000);

  test("--allow-private-network=false on the command line gives the same refusal", async () => {
    const r = await run(lite, ["fetch", `${listener.url}/`, "--allow-private-network=false"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("PRIVATE_NETWORK_BLOCKED");
    expect(listener.hits).toEqual([]);
  });

  test("the default for fetch is permissive: the same URL works without the setting", async () => {
    const r = await run(lite, ["fetch", `${listener.url}/article`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Heading One");
    listener.hits.length = 0;
  });

  test("search --scrape does not fetch private result URLs either", async () => {
    const m = mockSearx(() => [{ url: `${listener.url}/article`, title: "private", content: "x" }]);
    try {
      const r = await run(lite, ["search", "q", "--scrape", "--json"], { env: { SEX_SEARXNG_URL: m.url, SEX_ALLOW_PRIVATE_NETWORK: "0" } });
      expect(r.code).toBe(0);
      const item = r.json().data.web[0];
      expect(item.markdown).toBeUndefined();
      expect(item.metadata.statusCode).toBe(403);
      expect(listener.hits).toEqual([]);
    } finally {
      m.stop();
    }
  });
});

describe("HTTP API of a default `serve`", () => {
  test("POST /v2/scrape refuses loopback in every spelling with 403 PRIVATE_NETWORK_BLOCKED", async () => {
    const targets = Object.entries(loopbackTargets());
    const results = await Promise.all(targets.map(([, url]) => api(server.url, "/v2/scrape", { body: { url } })));
    for (const [i, r] of results.entries()) {
      const name = targets[i]![0];
      expect(r.status, name).toBe(403);
      expect(r.body.success, name).toBe(false);
      expect(r.body.code, name).toBe("PRIVATE_NETWORK_BLOCKED");
      expect(r.body.retryable, name).toBe(false);
    }
    expect(allHits()).toEqual([]);
  }, 120_000);

  test("POST /v2/scrape refuses the private ranges", async () => {
    const targets = Object.entries(OTHER_PRIVATE);
    const results = await Promise.all(targets.map(([, url]) => api(server.url, "/v2/scrape", { body: { url } })));
    for (const [i, r] of results.entries()) {
      expect(r.status, targets[i]![0]).toBe(403);
      expect(r.body.code, targets[i]![0]).toBe("PRIVATE_NETWORK_BLOCKED");
    }
  }, 120_000);

  test("a private URL cannot be smuggled through rawBase64, html formats or a Google Docs link", async () => {
    const url = `${listener.url}/article`;
    for (const body of [
      { url, formats: ["rawBase64"] },
      { url, formats: ["rawHtml", "links"] },
      { url, fastMode: true },
      { url, headers: { "X-Test": "1" } },
      { url, proxy: "stealth" },
    ]) {
      const r = await api(server.url, "/v2/scrape", { body });
      expect([403, 400, 501], JSON.stringify(body)).toContain(r.status);
      expect(r.body.success).toBe(false);
    }
    expect(allHits()).toEqual([]);
  });

  test("search results that point at private addresses are reported per item, not fetched", async () => {
    const m = mockSearx(() => [
      { url: `${listener.url}/article`, title: "private", content: "x" },
      { url: "http://169.254.169.254/latest/meta-data/", title: "metadata", content: "y" },
    ]);
    const s = await serve(lite, [], { env: { SEX_SEARXNG_URL: m.url } });
    try {
      const r = await api(s.url, "/v2/search", { body: { query: "q", scrapeOptions: { formats: ["markdown"] } } });
      expect(r.status).toBe(200);
      for (const item of r.body.data.web) {
        expect(item.markdown).toBeUndefined();
        expect(item.metadata.statusCode).toBe(403);
      }
      expect(allHits()).toEqual([]);
    } finally {
      await s.stop();
      m.stop();
    }
  });

  test("the setting can be switched on: --allow-private-network reaches the listener", async () => {
    const s = await serve(lite, ["--allow-private-network"]);
    try {
      const r = await api(s.url, "/v2/scrape", { body: { url: `${listener.url}/article`, formats: ["markdown"] } });
      expect(r.status).toBe(200);
      expect(r.body.data.markdown).toContain("Heading One");
      expect(listener.hits).toEqual(["/article"]);
    } finally {
      await s.stop();
      listener.hits.length = 0;
    }
  });

  test("SEX_ALLOW_PRIVATE_NETWORK=1 does the same", async () => {
    const s = await serve(lite, [], { env: { SEX_ALLOW_PRIVATE_NETWORK: "1" } });
    try {
      const r = await api(s.url, "/v2/scrape", { body: { url: `${listener.url}/article` } });
      expect(r.status).toBe(200);
    } finally {
      await s.stop();
      listener.hits.length = 0;
    }
  });
});

describe("a redirect from an allowed page to a private address", () => {
  const targets: Record<string, string> = {
    "127.0.0.1": "http://127.0.0.1:PORT/secret",
    localhost: "http://localhost:PORT/secret",
    "hex loopback": "http://0x7f000001:PORT/secret",
    metadata: "http://169.254.169.254/latest/meta-data/",
    "10.0.0.1": "http://10.0.0.1/",
    "[::1]": "http://[::1]:PORT/secret",
  };
  const redirecting = site((_req, url) => {
    const t = url.searchParams.get("to");
    if (url.pathname === "/redir" && t) return new Response(null, { status: 302, headers: { location: t } });
    if (url.pathname === "/public") return html("Public", `<main><h1>Public heading</h1>${prose("the public page")}</main>`);
    return new Response("not found", { status: 404 });
  });
  afterAll(() => redirecting.stop());
  const via = async () => startCountingProxy((u) => new URL(`${redirecting.url}${u.pathname}${u.search}`));

  test("CLI: every private target is refused at the hop with PRIVATE_NETWORK_BLOCKED; the listener sees nothing", async () => {
    const proxy = await via();
    try {
      for (const [name, tpl] of Object.entries(targets)) {
        const to = tpl.replace("PORT", port());
        const r = await run(lite, ["fetch", `http://93.184.216.34/redir?to=${encodeURIComponent(to)}`], {
          env: { SEX_PROXY_URL: proxy.url, SEX_ALLOW_PRIVATE_NETWORK: "0" },
        });
        expect(r.code, `${name}: ${r.stderr}`).toBe(1);
        expect(r.stderr, name).toContain("PRIVATE_NETWORK_BLOCKED");
        expect(r.stdout, name).toBe("");
      }
      expect(allHits()).toEqual([]);
      // The first hop did go through the proxy, and only the first hop.
      expect(proxy.requests.length).toBe(Object.keys(targets).length);
      expect(proxy.requests.every((q) => q.url.startsWith("http://93.184.216.34/redir"))).toBe(true);
    } finally {
      proxy.close();
    }
  }, 120_000);

  test("HTTP API: the same, as 403", async () => {
    const proxy = await via();
    const s = await serve(lite, [], { env: { SEX_PROXY_URL: proxy.url } });
    try {
      for (const [name, tpl] of Object.entries(targets)) {
        const to = tpl.replace("PORT", port());
        const r = await api(s.url, "/v2/scrape", { body: { url: `http://93.184.216.34/redir?to=${encodeURIComponent(to)}` } });
        expect(r.status, name).toBe(403);
        expect(r.body.code, name).toBe("PRIVATE_NETWORK_BLOCKED");
      }
      expect(allHits()).toEqual([]);
    } finally {
      await s.stop();
      proxy.close();
    }
  }, 120_000);

  test("control: a redirect to another public address is followed (so the refusals above are the policy)", async () => {
    const proxy = await via();
    try {
      const r = await run(lite, ["fetch", `http://93.184.216.34/redir?to=${encodeURIComponent("http://93.184.216.35/public")}`, "--json"], {
        env: { SEX_PROXY_URL: proxy.url, SEX_ALLOW_PRIVATE_NETWORK: "0" },
      });
      expect(r.code, r.stderr).toBe(0);
      expect(r.json().data.markdown).toContain("about the public page");
      expect(r.json().data.metadata.url).toBe("http://93.184.216.35/public");
    } finally {
      proxy.close();
    }
  }, 60_000);
});
