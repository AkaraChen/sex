// A remote-controlled Chrome (`--cdp-url`): what a page looks like through it, and that sex's own rules stay in force.
// Pages sit at the public IP literal 93.184.216.34 and reach a local fixture through SEX_PROXY_URL (see ssrf.test.ts for why);
// with Chrome on this machine, sex routes the browser through its EgressProxy, which chains to that proxy.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { bin } from "../lib/bin.ts";
import { api, killAll, run } from "../lib/proc.ts";
import { cdpUrl } from "../lib/services.ts";
import { html, prose } from "../lib/sites.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { type Listener, PUBLIC_IP, type PublicSite, startListener, startPublicSite, startSex } from "./support.ts";

const cdp = cdpUrl();
let tripwire: Listener;
let pub: PublicSite;

beforeAll(async () => {
  tripwire = await startListener();
  pub = await startPublicSite((_req, url) => {
    switch (url.pathname) {
      case "/static":
        return html(
          "Static page",
          `<main><article><h1>Static heading</h1>${prose("static")}<a href="/other">Other page</a><a href="http://127.0.0.1:${tripwire.port}/x">Private link</a></article></main>`,
        );
      case "/js":
        // Nothing in the HTML source: the article exists only after the script has run.
        return html(
          "JS shell",
          `<div id="app"></div><script>setTimeout(function(){document.title="Rendered title";document.getElementById("app").innerHTML="<main><article><h1>Rendered heading</h1>${prose("rendered", 4).replaceAll('"', "'")}</article></main>"},200)</script>`,
        );
      case "/js-fetch":
        return html(
          "Fetch shell",
          `<div id="app"></div><script>fetch("/api/data").then(function(r){return r.json()}).then(function(d){document.getElementById("app").innerHTML="<main><article><h1>"+d.heading+"</h1><p>"+d.body+"</p></article></main>"})</script>`,
        );
      case "/api/data":
        return Response.json({ heading: "Heading from the API", body: `${"Data that arrived over fetch. ".repeat(20)}` });
      case "/redirect":
        return new Response(null, { status: 302, headers: { location: "/static" } });
      case "/missing":
        return new Response(html("Gone", `<main><article><h1>Not here</h1>${prose("gone")}</article></main>`).body, {
          status: 404,
          headers: { "content-type": "text/html" },
        });
      case "/slow":
        return new Promise<Response>((resolve) => setTimeout(() => resolve(html("Slow", prose("slow"))), 6000));
      case "/click":
        return html(
          "Click page",
          `<main><article><h1>Before click</h1>${prose("click")}<button id="b" onclick="document.querySelector('h1').textContent='After click'">go</button></article></main>`,
        );
      default:
        return html("Other", `<main><article><h1>Other heading</h1>${prose("other")}</article></main>`);
    }
  });
});
beforeEach(() => {
  tripwire.connections.length = 0;
  pub.clear();
});
afterAll(async () => {
  tripwire?.stop();
  pub?.stop();
  await killAll();
  removeTempDirs();
});

describe.skipIf(!cdp)("Chrome through --cdp-url", () => {
  const start = () => startSex(["--cdp-url", cdp as string], { SEX_PROXY_URL: pub.proxyUrl });

  test("health reports the browser; a static page comes back with metadata and links", async () => {
    const s = await start();
    expect((await api(s.url, "/health")).body.browser).toContain(new URL(cdp as string).host);
    const res = await api(s.url, "/v2/scrape", { body: { url: `${pub.origin}/static`, formats: ["markdown", "links"], timeout: 40_000 } });
    expect(res.status).toBe(200);
    const doc = res.body.data;
    expect(doc.markdown).toContain("Static heading");
    expect(doc.metadata).toMatchObject({ statusCode: 200, sourceURL: `${pub.origin}/static`, title: "Static page" });
    expect(doc.links).toContain(`${pub.origin}/other`);
    // The page's link to a private address is only a link; nothing fetched it.
    expect(tripwire.connections).toEqual([]);
    await s.stop();
  }, 90_000);

  test("a page that only exists after JavaScript ran is rendered; plain HTTP does not see it", async () => {
    const s = await start();
    const res = await api(s.url, "/v2/scrape", { body: { url: `${pub.origin}/js`, formats: ["markdown"], waitFor: 800, timeout: 40_000 } });
    expect(res.status).toBe(200);
    expect(res.body.data.markdown).toContain("Rendered heading");
    expect(res.body.data.metadata.title).toBe("Rendered title");

    const plain = await startSex([], { SEX_PROXY_URL: pub.proxyUrl });
    const flat = await api(plain.url, "/v2/scrape", { body: { url: `${pub.origin}/js`, formats: ["markdown"] } });
    expect(flat.body.data?.markdown ?? "").not.toContain("Rendered heading");
    await Promise.all([s.stop(), plain.stop()]);
  }, 90_000);

  test("data the page loads with fetch() goes through sex and the proxy, and ends up in the document", async () => {
    const s = await start();
    const res = await api(s.url, "/v2/scrape", {
      body: { url: `${pub.origin}/js-fetch`, formats: ["markdown"], waitFor: 800, timeout: 40_000 },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.markdown).toContain("Heading from the API");
    expect(pub.proxied).toContain(`http://${PUBLIC_IP}/api/data`);
    await s.stop();
  }, 90_000);

  test("a redirect between public pages is followed; the final URL is reported", async () => {
    const s = await start();
    const res = await api(s.url, "/v2/scrape", { body: { url: `${pub.origin}/redirect`, formats: ["markdown"], timeout: 40_000 } });
    expect(res.status).toBe(200);
    expect(res.body.data.markdown).toContain("Static heading");
    expect(res.body.data.metadata.url).toBe(`${pub.origin}/static`);
    await s.stop();
  }, 90_000);

  test("a 404 keeps its status code", async () => {
    const s = await start();
    const res = await api(s.url, "/v2/scrape", { body: { url: `${pub.origin}/missing`, formats: ["markdown"], timeout: 40_000 } });
    // Either the document with statusCode 404, or an error that carries it.
    const status = res.body.data?.metadata?.statusCode ?? res.body.statusCode ?? res.status;
    expect(status).toBe(404);
    await s.stop();
  }, 90_000);

  test("actions run in the page (click, then the changed DOM is extracted)", async () => {
    const s = await start();
    const res = await api(s.url, "/v2/scrape", {
      body: {
        url: `${pub.origin}/click`,
        formats: ["markdown"],
        actions: [
          { type: "click", selector: "#b" },
          { type: "wait", milliseconds: 200 },
        ],
        timeout: 40_000,
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.markdown).toContain("After click");
    await s.stop();
  }, 90_000);

  test("a page slower than the request timeout is SCRAPE_TIMEOUT (408), and the server keeps working", async () => {
    const s = await start();
    const res = await api(s.url, "/v2/scrape", { body: { url: `${pub.origin}/slow`, timeout: 1000 } });
    expect(res.status).toBe(408);
    expect(res.body.code).toBe("SCRAPE_TIMEOUT");
    const again = await api(s.url, "/v2/scrape", { body: { url: `${pub.origin}/other`, timeout: 40_000 } });
    expect(again.status).toBe(200);
    await s.stop();
  }, 90_000);

  test("parallel scrapes do not mix pages up (each gets its own browser context)", async () => {
    const s = await start();
    const paths = ["static", "other", "js-fetch", "js", "static", "other"];
    const results = await Promise.all(
      paths.map((p) =>
        api(s.url, "/v2/scrape", { body: { url: `${pub.origin}/${p}`, formats: ["markdown"], waitFor: 800, timeout: 60_000 } }),
      ),
    );
    const expected: Record<string, string> = {
      static: "Static heading",
      other: "Other heading",
      "js-fetch": "Heading from the API",
      js: "Rendered heading",
    };
    results.forEach((r, i) => {
      expect(r.status).toBe(200);
      expect(r.body.data.markdown).toContain(expected[paths[i] as string] as string);
    });
    await s.stop();
  }, 120_000);

  test("sex leaves no browser contexts behind: the pages Chrome has open after the scrapes are the ones it started with", async () => {
    const s = await start();
    const count = async () => ((await (await fetch(`${cdp}/json/list`)).json()) as unknown[]).length;
    const before = await count();
    for (let i = 0; i < 3; i++) await api(s.url, "/v2/scrape", { body: { url: `${pub.origin}/static`, timeout: 40_000 } });
    // Closing a context is asynchronous in Chrome; give it a moment.
    await Bun.sleep(500);
    expect(await count()).toBeLessThanOrEqual(before);
    await s.stop();
  }, 90_000);
});

describe("an unreachable --cdp-url", () => {
  test("serve refuses to start, naming BROWSER_UNAVAILABLE", async () => {
    const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no") });
    const port = dead.port;
    dead.stop(true);
    const r = await run(bin("sex"), ["serve", "--port", "0", "--cdp-url", `http://127.0.0.1:${port}`, "--log-level", "info"], {
      timeoutMs: 60_000,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("BROWSER_UNAVAILABLE");
    expect(r.stderr).toContain(`127.0.0.1:${port}`);
  }, 90_000);
});
