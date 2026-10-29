import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config.ts";
import { Engine } from "../src/engine/engine.ts";
import { startCountingProxy } from "./helpers.ts";

// Opt-in, needs a browser (see browser.test.ts): the browser's traffic goes through the proxy and private targets stay refused.
const CDP = process.env.SEX_TEST_CDP_URL;
const LIGHTPANDA = process.env.SEX_TEST_LIGHTPANDA_PATH;
const variants: Array<[string, { cdpUrl?: string; lightpanda?: boolean; lightpandaPath?: string }]> = [];
if (CDP) variants.push(["cdp", { cdpUrl: CDP }]);
if (LIGHTPANDA) variants.push(["spawned lightpanda", { lightpanda: true, lightpandaPath: LIGHTPANDA }]);

// A public IP literal passes the guard without DNS; the proxy delivers it to the local fixture.
const PUBLIC = "http://93.184.216.34";
const AUTH = "user:p@ss";

describe.each(variants)("browser through a proxy (%s)", (_name, browser) => {
  let site: ReturnType<typeof Bun.serve>;
  let internal: ReturnType<typeof Bun.serve>;
  let proxy: Awaited<ReturnType<typeof startCountingProxy>>;
  let engine: Engine;
  const siteHits: string[] = [];
  const internalHits: string[] = [];

  beforeAll(async () => {
    internal = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        internalHits.push(req.url);
        return new Response("secret", { headers: { "content-type": "text/javascript" } });
      },
    });
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        siteHits.push(new URL(req.url).pathname);
        if (new URL(req.url).pathname === "/sub") {
          // A page on a public address that reaches for internal ones: loopback, localhost, cloud metadata, private ranges.
          const targets = [
            `127.0.0.1:${internal.port}`,
            `localhost:${internal.port}`,
            "169.254.169.254",
            "10.0.0.1",
            `[::1]:${internal.port}`,
          ];
          const refs = targets.flatMap((t) => [`<script src="http://${t}/a.js"></script>`, `<img src="http://${t}/i.png">`]);
          return new Response(
            `<!doctype html><title>Sub</title><body><main><article><p>page with subresources</p></article></main>${refs.join("")}</body>`,
            {
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          );
        }
        return new Response(
          "<!doctype html><html><head><title>Proxied</title></head><body><main><article><p>seen through the proxy</p></article></main></body></html>",
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      },
    });
    proxy = await startCountingProxy((u) => new URL(u.pathname, `http://127.0.0.1:${site.port}`), { auth: AUTH });
    engine = new Engine(
      resolveConfig(
        { ...browser, concurrency: 2, timeout: 15_000, searxngUrl: "http://127.0.0.1:1" },
        { allowPrivateNetwork: false },
        { SEX_PROXY_URL: proxy.url.replace("//", `//${encodeURIComponent("user")}:${encodeURIComponent("p@ss")}@`) },
      ),
    );
  });
  afterAll(async () => {
    await engine?.browser.close();
    site?.stop(true);
    internal?.stop(true);
    proxy?.close();
  });
  beforeEach(() => {
    proxy.requests.length = 0;
    siteHits.length = 0;
    internalHits.length = 0;
  });

  test("loads the page through the proxy", async () => {
    const doc = await engine.scrape({ url: `${PUBLIC}/page`, formats: ["markdown"] });
    expect(doc.markdown).toContain("seen through the proxy");
    expect(proxy.requests.some((r) => r.url === `${PUBLIC}/page`)).toBe(true);
    expect(siteHits).toContain("/page");
  });

  test("a private address is refused and the proxy is never asked for it", async () => {
    await expect(engine.scrape({ url: `http://127.0.0.1:${site.port}/secret`, formats: ["markdown"] })).rejects.toMatchObject({
      code: "PRIVATE_NETWORK_BLOCKED",
    });
    expect(proxy.requests.filter((r) => r.url.includes("/secret"))).toEqual([]);
    expect(siteHits).not.toContain("/secret");
  });

  test("internal addresses a public page reaches for are refused before the proxy and the internal service sees nothing", async () => {
    const doc = await engine.scrape({ url: `${PUBLIC}/sub`, formats: ["markdown"] });
    expect(doc.markdown).toContain("page with subresources");
    expect(internalHits).toEqual([]);
    expect(proxy.requests.map((r) => r.url).filter((u) => /127\.0\.0\.1|localhost|169\.254|10\.0\.0\.1|\[::1\]/.test(u))).toEqual([]);
    expect(proxy.connects.filter((c) => /127\.0\.0\.1|localhost|169\.254|10\.0\.0\.1|::1/.test(c))).toEqual([]);
  });
});
