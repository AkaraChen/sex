import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config.ts";
import { contextProxy, lightpandaArgv, redactArgv } from "../src/engine/browser.ts";
import { Engine } from "../src/engine/engine.ts";
import { startCountingProxy } from "./helpers.ts";

describe("browser proxy settings", () => {
  const base = { concurrency: 4, allowPrivateNetwork: false };

  test("Lightpanda gets --http-proxy; without a proxy there is no flag", () => {
    expect(lightpandaArgv("lp", 1, base)).not.toContain("--http-proxy");
    const argv = lightpandaArgv("lp", 1, { ...base, proxyUrl: "http://u:p@proxy:3128" });
    expect(argv.slice(argv.indexOf("--http-proxy"), argv.indexOf("--http-proxy") + 2)).toEqual(["--http-proxy", "http://u:p@proxy:3128"]);
    expect(argv).toContain("--block-private-networks");
  });

  test("the proxy's credentials are masked in the logged command line", () => {
    const logged = redactArgv(lightpandaArgv("lp", 1, { ...base, proxyUrl: "http://user:secret@proxy:3128" })).join(" ");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("user:");
    expect(logged).toContain("proxy:3128");
  });

  test("an external CDP browser gets the proxy per context, credentials apart from the server", () => {
    expect(contextProxy({ proxyUrl: "http://proxy:3128" })).toBeUndefined(); // spawned Lightpanda: command line instead
    expect(contextProxy({ cdpUrl: "ws://chrome:9222" })).toBeUndefined();
    expect(contextProxy({ cdpUrl: "ws://chrome:9222", proxyUrl: "http://proxy:3128" })).toEqual({ server: "http://proxy:3128" });
    expect(contextProxy({ cdpUrl: "ws://chrome:9222", proxyUrl: "https://us%40er:p%3Aw@proxy.example:8443/" })).toEqual({
      server: "https://proxy.example:8443",
      credentials: { username: "us@er", password: "p:w" },
    });
  });
});

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
  let proxy: Awaited<ReturnType<typeof startCountingProxy>>;
  let engine: Engine;
  const siteHits: string[] = [];

  beforeAll(async () => {
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        siteHits.push(new URL(req.url).pathname);
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
    proxy?.close();
  });
  beforeEach(() => {
    proxy.requests.length = 0;
    siteHits.length = 0;
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
});
