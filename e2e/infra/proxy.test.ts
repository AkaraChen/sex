// SEX_PROXY_URL / SEX_STEALTH_PROXY_URL: an authenticating forward proxy (startCountingProxy with Basic auth, which logs every
// absolute-form request and CONNECT with the headers it got) in front of a local fixture, addressed as the public IP literal
// 93.184.216.34 (see ssrf.test.ts). The proxy URLs carry credentials; they must reach the proxy and nowhere else.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { api, killAll } from "../lib/proc.ts";
import { cdpUrl } from "../lib/services.ts";
import { html, prose } from "../lib/sites.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import {
  childrenOf,
  type Listener,
  PUBLIC_IP,
  type PublicSite,
  privateTargets,
  startListener,
  startPublicSite,
  startSex,
} from "./support.ts";

const USER = "proxyuser";
const PASS = "pw-Zk93-leakcheck";
const STEALTH_USER = "stealthuser";
const STEALTH_PASS = "st-Qx71-leakcheck";
/** Every form the credentials could leak in. */
const secrets = [PASS, STEALTH_PASS, btoa(`${USER}:${PASS}`), btoa(`${STEALTH_USER}:${STEALTH_PASS}`), encodeURIComponent(PASS)];
const expectedAuth = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`;

const page = (title: string) => html(title, `<main><article><h1>${title}</h1>${prose(title)}</article></main>`);

let tripwire: Listener;
/** SEX_PROXY_URL: delivers the fixture's pages. */
let basic: PublicSite;
/** The site as the "direct" proxy shows it: blocked. */
let blocked: PublicSite;
/** SEX_STEALTH_PROXY_URL: the same URLs, let through. */
let stealth: PublicSite;

beforeAll(async () => {
  tripwire = await startListener();
  basic = await startPublicSite(
    (_req, url) =>
      url.pathname === "/js"
        ? html(
            "JS",
            `<div id=a></div><script>document.getElementById("a").innerHTML="<main><article><h1>Rendered via proxy</h1>${prose("js").replaceAll('"', "'")}</article></main>"</script>`,
          )
        : page(`Basic ${url.pathname}`),
    { auth: `${USER}:${PASS}` },
  );
  blocked = await startPublicSite(
    () =>
      new Response("<html><head><title>403</title></head><body><h1>403 Forbidden</h1><p>Blocked by the site.</p></body></html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
    {
      auth: `${USER}:${PASS}`,
    },
  );
  stealth = await startPublicSite((_req, url) => page(`Stealth ${url.pathname}`), { auth: `${STEALTH_USER}:${STEALTH_PASS}` });
});
beforeEach(() => {
  tripwire.connections.length = 0;
  for (const p of [basic, blocked, stealth]) p.clear();
});
afterAll(async () => {
  tripwire?.stop();
  for (const p of [basic, blocked, stealth]) p?.stop();
  await killAll();
  removeTempDirs();
});

const noSecrets = (label: string, text: string) => {
  for (const secret of secrets) expect([label, text.includes(secret)]).toEqual([label, false]);
};

/** The command line of a process and of its direct children. */
const cmdlines = async (pid: number) => {
  const read = (p: number) => {
    try {
      return readFileSync(`/proc/${p}/cmdline`, "latin1").replaceAll("\0", " ");
    } catch {
      return "";
    }
  };
  return [read(pid), ...(await childrenOf(pid)).map(read)];
};

describe("SEX_PROXY_URL with credentials", () => {
  test("a plain fetch goes through the proxy with the URL's credentials, and only the request reaches the proxy", async () => {
    const s = await startSex(["--log-level", "debug"], { SEX_PROXY_URL: basic.proxyUrl });
    const res = await api(s.url, "/v2/scrape", { body: { url: `${basic.origin}/page`, formats: ["markdown"] } });
    expect(res.status).toBe(200);
    expect(res.body.data.markdown).toContain("Basic /page");
    const seen = basic.proxiedRequests.filter((r) => r.url === `http://${PUBLIC_IP}/page`);
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) expect(r.headers.get("proxy-authorization")).toBe(expectedAuth(USER, PASS));

    // The credentials are nowhere else: not in the logs (debug), /health, the response, the process list.
    noSecrets("response", JSON.stringify(res.body));
    noSecrets("health", JSON.stringify((await api(s.url, "/health")).body));
    noSecrets("openapi", JSON.stringify((await api(s.url, "/openapi.json")).body));
    noSecrets("stderr", s.stderr());
    for (const line of await cmdlines(s.proc.pid)) noSecrets("cmdline", line);
    await s.stop();
  }, 90_000);

  test("private targets are refused before the proxy sees anything", async () => {
    const s = await startSex([], { SEX_PROXY_URL: basic.proxyUrl });
    for (const { name, host } of privateTargets(tripwire.port)) {
      const res = await api(s.url, "/v2/scrape", { body: { url: `http://${host}/secret` } });
      expect([name, res.status, res.body.code]).toEqual([name, 403, "PRIVATE_NETWORK_BLOCKED"]);
    }
    expect(basic.proxiedRequests).toEqual([]);
    expect(basic.connects).toEqual([]);
    expect(tripwire.connections).toEqual([]);
    await s.stop();
  }, 60_000);

  test("wrong credentials: the scrape fails with a message, and the message does not contain the credentials", async () => {
    const wrong = basic.proxyUrl.replace(PASS, "not-the-password");
    const s = await startSex(["--log-level", "debug"], { SEX_PROXY_URL: wrong });
    const res = await api(s.url, "/v2/scrape", { body: { url: `${basic.origin}/page` } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.success).toBe(false);
    for (const text of [JSON.stringify(res.body), s.stderr()]) {
      expect(text).not.toContain("not-the-password");
      noSecrets("wrong", text);
    }
    await s.stop();
  }, 60_000);

  test("an unreachable proxy is a clear error that does not echo the URL's credentials", async () => {
    const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const port = dead.port;
    dead.stop(true);
    const s = await startSex(["--log-level", "debug"], { SEX_PROXY_URL: `http://${USER}:${PASS}@127.0.0.1:${port}` });
    const res = await api(s.url, "/v2/scrape", { body: { url: `http://${PUBLIC_IP}/page` } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    noSecrets("response", JSON.stringify(res.body));
    noSecrets("stderr", s.stderr());
    await s.stop();
  }, 60_000);

  test("an invalid SEX_PROXY_URL is CONFIG_INVALID and the message does not echo the credentials", async () => {
    const { run } = await import("../lib/proc.ts");
    const { bin } = await import("../lib/bin.ts");
    const r = await run(bin("sex"), ["fetch", "http://example.invalid/"], {
      env: { SEX_PROXY_URL: `socks5://${USER}:${PASS}@127.0.0.1:1` },
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("CONFIG_INVALID");
    noSecrets("config error", r.stderr + r.stdout);
  }, 60_000);

  test("Lightpanda: the browser's traffic reaches the proxy with the URL's credentials only; none on a command line", async () => {
    const s = await startSex(["--lightpanda", "--log-level", "debug"], { SEX_PROXY_URL: basic.proxyUrl });
    const res = await api(s.url, "/v2/scrape", {
      body: { url: `${basic.origin}/js`, formats: ["markdown"], waitFor: 500, timeout: 45_000 },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.markdown).toContain("Rendered via proxy");
    expect(basic.proxiedRequests.length).toBeGreaterThan(0);
    // sex's EgressProxy hands the browser its own random credentials; upstream only ever sees the configured ones.
    for (const r of basic.proxiedRequests) expect(r.headers.get("proxy-authorization")).toBe(expectedAuth(USER, PASS));
    noSecrets("response", JSON.stringify(res.body));
    noSecrets("stderr", s.stderr());
    for (const line of await cmdlines(s.proc.pid)) {
      noSecrets("cmdline", line);
      expect(line).not.toContain(basic.proxyUrl);
    }
    await s.stop();
  }, 120_000);

  const cdp = cdpUrl();
  test.skipIf(!cdp)(
    "Chrome on this machine: same, through the EgressProxy",
    async () => {
      const s = await startSex(["--cdp-url", cdp as string, "--log-level", "debug"], { SEX_PROXY_URL: basic.proxyUrl });
      const res = await api(s.url, "/v2/scrape", {
        body: { url: `${basic.origin}/js`, formats: ["markdown"], waitFor: 500, timeout: 45_000 },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.markdown).toContain("Rendered via proxy");
      for (const r of basic.proxiedRequests) expect(r.headers.get("proxy-authorization")).toBe(expectedAuth(USER, PASS));
      expect(basic.proxiedRequests.length).toBeGreaterThan(0);
      noSecrets("response", JSON.stringify(res.body));
      noSecrets("stderr", s.stderr());
      // Private main documents never reach the upstream proxy.
      basic.clear();
      for (const { name, host } of privateTargets(tripwire.port)) {
        const r = await api(s.url, "/v2/scrape", { body: { url: `http://${host}/secret`, timeout: 30_000 } });
        expect([name, r.body.code]).toEqual([name, "PRIVATE_NETWORK_BLOCKED"]);
      }
      expect(basic.proxiedRequests).toEqual([]);
      expect(tripwire.connections).toEqual([]);
      await s.stop();
    },
    300_000,
  );
});

describe("SEX_STEALTH_PROXY_URL", () => {
  const env = () => ({ SEX_PROXY_URL: blocked.proxyUrl, SEX_STEALTH_PROXY_URL: stealth.proxyUrl });

  test("a site that blocks the basic proxy (403) is fetched through the stealth one: metadata.proxyUsed is stealth", async () => {
    const s = await startSex(["--log-level", "debug"], env());
    const res = await api(s.url, "/v2/scrape", { body: { url: `${blocked.origin}/page`, formats: ["markdown"] } });
    expect(res.status).toBe(200);
    expect(res.body.data.markdown).toContain("Stealth /page");
    expect(res.body.data.metadata.statusCode).toBe(200);
    expect(res.body.data.metadata.proxyUsed).toBe("stealth");
    expect(res.body.data.warning).toMatch(/stealth/i);
    // Each proxy was asked once, with its own credentials.
    expect(blocked.proxiedRequests.map((r) => r.url)).toEqual([`http://${PUBLIC_IP}/page`]);
    expect(blocked.proxiedRequests[0]?.headers.get("proxy-authorization")).toBe(expectedAuth(USER, PASS));
    expect(stealth.proxiedRequests.map((r) => r.url)).toEqual([`http://${PUBLIC_IP}/page`]);
    expect(stealth.proxiedRequests[0]?.headers.get("proxy-authorization")).toBe(expectedAuth(STEALTH_USER, STEALTH_PASS));
    noSecrets("response", JSON.stringify(res.body));
    noSecrets("health", JSON.stringify((await api(s.url, "/health")).body));
    noSecrets("stderr", s.stderr());
    await s.stop();
  }, 60_000);

  test('proxy: "basic" never retries: the 403 stands and the stealth proxy is never asked', async () => {
    const s = await startSex([], env());
    const res = await api(s.url, "/v2/scrape", { body: { url: `${blocked.origin}/page`, formats: ["markdown"], proxy: "basic" } });
    expect(res.body.data?.metadata?.statusCode ?? res.body.statusCode ?? res.status).toBe(403);
    expect(res.body.data?.metadata?.proxyUsed ?? "basic").toBe("basic");
    expect(stealth.proxiedRequests).toEqual([]);
    await s.stop();
  }, 60_000);

  test('proxy: "stealth" starts with the stealth proxy; the basic one is never asked', async () => {
    const s = await startSex([], env());
    const res = await api(s.url, "/v2/scrape", { body: { url: `${blocked.origin}/page`, formats: ["markdown"], proxy: "stealth" } });
    expect(res.status).toBe(200);
    expect(res.body.data.metadata.proxyUsed).toBe("stealth");
    expect(blocked.proxiedRequests).toEqual([]);
    expect(stealth.proxiedRequests).toHaveLength(1);
    await s.stop();
  }, 60_000);

  test("without SEX_STEALTH_PROXY_URL the 403 is returned as it is; with the same proxy twice there is no retry either", async () => {
    for (const stealthUrl of [undefined, blocked.proxyUrl]) {
      blocked.clear();
      const s = await startSex([], { SEX_PROXY_URL: blocked.proxyUrl, SEX_STEALTH_PROXY_URL: stealthUrl });
      const res = await api(s.url, "/v2/scrape", { body: { url: `${blocked.origin}/page`, formats: ["markdown"] } });
      expect(res.body.data?.metadata?.statusCode ?? res.body.statusCode ?? res.status).toBe(403);
      expect(blocked.proxiedRequests).toHaveLength(1);
      expect(stealth.proxiedRequests).toEqual([]);
      await s.stop();
    }
  }, 90_000);

  test("a page that is not blocked (200 through the basic proxy) never touches the stealth proxy", async () => {
    const s = await startSex([], { SEX_PROXY_URL: basic.proxyUrl, SEX_STEALTH_PROXY_URL: stealth.proxyUrl });
    const res = await api(s.url, "/v2/scrape", { body: { url: `${basic.origin}/fine`, formats: ["markdown"] } });
    expect(res.status).toBe(200);
    expect(res.body.data.metadata.proxyUsed).toBe("basic");
    expect(stealth.proxiedRequests).toEqual([]);
    await s.stop();
  }, 60_000);

  test("a browser page the site blocks (403) is replaced by a plain fetch through the stealth proxy", async () => {
    const s = await startSex(["--lightpanda"], env());
    const res = await api(s.url, "/v2/scrape", { body: { url: `${blocked.origin}/page`, formats: ["markdown"], timeout: 45_000 } });
    expect(res.status).toBe(200);
    expect(res.body.data.markdown).toContain("Stealth /page");
    expect(res.body.data.metadata.proxyUsed).toBe("stealth");
    expect(res.body.data.warning).toMatch(/stealth/i);
    for (const r of stealth.proxiedRequests) expect(r.headers.get("proxy-authorization")).toBe(expectedAuth(STEALTH_USER, STEALTH_PASS));
    await s.stop();
  }, 90_000);

  test("stealth does not open a way around the SSRF rule: private targets are refused with proxy: stealth too", async () => {
    const s = await startSex([], env());
    for (const { name, host } of privateTargets(tripwire.port)) {
      const res = await api(s.url, "/v2/scrape", { body: { url: `http://${host}/secret`, proxy: "stealth" } });
      expect([name, res.status, res.body.code]).toEqual([name, 403, "PRIVATE_NETWORK_BLOCKED"]);
    }
    expect(stealth.proxiedRequests).toEqual([]);
    expect(tripwire.connections).toEqual([]);
    await s.stop();
  }, 60_000);
});
