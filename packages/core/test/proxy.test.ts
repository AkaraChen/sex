// SEX_PROXY_URL: the proxy is used, and the SSRF checks stay in front of it.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resolveCoreConfig } from "../src/config.ts";
import { Deadline } from "../src/deadline.ts";
import { BaseEngine } from "../src/engine.ts";
import { safeFetch } from "../src/net.ts";
import { startCountingProxy } from "./helpers.ts";

// A public IP literal needs no DNS lookup to pass the check; the proxy delivers it to the local fixture instead.
const PUBLIC = "http://93.184.216.34";

describe("safeFetch through a proxy", () => {
  let site: ReturnType<typeof Bun.serve>;
  let proxy: Awaited<ReturnType<typeof startCountingProxy>>;

  beforeAll(async () => {
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/to-private")
          return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${site.port}/secret` } });
        if (pathname === "/secret") return new Response("internal");
        return new Response(`hello ${pathname}`, { headers: { "content-type": "text/plain" } });
      },
    });
    proxy = await startCountingProxy((u) => new URL(`${u.pathname}${u.search}`, `http://127.0.0.1:${site.port}`));
  });
  afterAll(() => {
    site.stop(true);
    proxy.close();
  });
  beforeEach(() => {
    proxy.requests.length = 0;
    proxy.connects.length = 0;
  });

  const get = (url: string, extra: { proxy?: string; headers?: Record<string, string> } = {}) =>
    safeFetch(url, {
      deadline: Deadline.start(5_000),
      allowPrivateNetwork: false,
      userAgent: "t",
      proxy: proxy.url,
      ...extra,
    });

  test("sends the request through the proxy, without pinning the address", async () => {
    const res = await get(`${PUBLIC}/page?q=1`);
    expect(await new Response(res.body).text()).toBe("hello /page");
    expect(proxy.requests.map((r) => r.url)).toEqual([`${PUBLIC}/page?q=1`]);
  });

  test.each([
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/",
    "http://[::ffff:7f00:1]/",
    "http://localhost/",
    "http://anything.localhost/",
  ])("still refuses %s and never contacts the proxy", async (url) => {
    await expect(get(url)).rejects.toMatchObject({ code: "PRIVATE_NETWORK_BLOCKED" });
    expect(proxy.requests).toEqual([]);
    expect(proxy.connects).toEqual([]);
  });

  test("refuses a name that does not resolve here, since the proxy would resolve it on its own", async () => {
    await expect(get("http://no-such-host.invalid/")).rejects.toMatchObject({ code: "SCRAPE_DNS_RESOLUTION_ERROR" });
    expect(proxy.requests).toEqual([]);
  });

  test("checks every redirect hop: a redirect to a private address is not followed", async () => {
    await expect(get(`${PUBLIC}/to-private`)).rejects.toMatchObject({ code: "PRIVATE_NETWORK_BLOCKED" });
    expect(proxy.requests.map((r) => r.url)).toEqual([`${PUBLIC}/to-private`]);
  });

  test("a Proxy-Authorization header from the caller is not passed on; the proxy's own credentials come from its URL", async () => {
    await get(`${PUBLIC}/page`, { headers: { "Proxy-Authorization": "Basic Y2FsbGVyOmNhbGxlcg==" } });
    expect(proxy.requests[0]?.headers.get("proxy-authorization")).toBeNull();
    proxy.requests.length = 0;
    await get(`${PUBLIC}/page`, { proxy: proxy.url.replace("//", "//user:pw@"), headers: { "Proxy-Authorization": "Basic Y2FsbGVy" } });
    expect(proxy.requests[0]?.headers.get("proxy-authorization")).toBe(`Basic ${btoa("user:pw")}`);
  });
});

describe("SEX_PROXY_URL", () => {
  test("is read into the config and applied to scrapes", async () => {
    const site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("<html><body><main><p>via proxy</p></main></body></html>", { headers: { "content-type": "text/html" } }),
    });
    const proxy = await startCountingProxy((u) => new URL(u.pathname, `http://127.0.0.1:${site.port}`));
    try {
      const config = resolveCoreConfig({ searxngUrl: "http://127.0.0.1:1" }, { allowPrivateNetwork: false }, { SEX_PROXY_URL: proxy.url });
      expect(config.proxyUrl).toBe(proxy.url);
      const engine = new BaseEngine(config);
      const document = await engine.scrape({ url: `${PUBLIC}/` });
      expect(document.markdown).toContain("via proxy");
      expect(proxy.requests.map((r) => r.url)).toEqual([`${PUBLIC}/`]);
      await expect(engine.scrape({ url: "http://127.0.0.1/" })).rejects.toMatchObject({ code: "PRIVATE_NETWORK_BLOCKED" });
      expect(proxy.requests).toHaveLength(1);
    } finally {
      site.stop(true);
      proxy.close();
    }
  });

  test("is unset by default and ignores an empty value", () => {
    expect(resolveCoreConfig({}, undefined, {}).proxyUrl).toBeUndefined();
    expect(resolveCoreConfig({}, undefined, { SEX_PROXY_URL: " " }).proxyUrl).toBeUndefined();
  });

  test("must be an http(s) URL, and an invalid value is not echoed back (it may hold credentials)", () => {
    const err = (() => {
      try {
        resolveCoreConfig({}, undefined, { SEX_PROXY_URL: "socks5://user:secret@proxy:1080" });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toMatchObject({ code: "CONFIG_INVALID" });
    expect(err?.message).toContain("SEX_PROXY_URL");
    expect(err?.message).not.toContain("secret");
  });
});
