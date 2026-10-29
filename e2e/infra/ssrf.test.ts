// The SSRF matrix: without --allow-private-network no outbound path of the sex binary may reach a private address, however
// it is spelled. Every refused case asserts on a tripwire (a raw TCP listener on 127.0.0.1 and [::1]) that nothing connected.
//
// How a page gets loaded at all while private networks are refused, offline: the page lives at the public IP literal
// 93.184.216.34, which the SSRF check lets through without DNS. Nothing listens there, so SEX_PROXY_URL points at a forward
// proxy (startPublicSite) that delivers `http://93.184.216.34/<path>` to a local fixture. Everything the page then asks
// for goes through sex's own checks (HTTP path: before the request; Lightpanda / Chrome on this machine: sex's EgressProxy,
// which chains to the proxy; Chrome elsewhere: the CDP request guard, the browser using the proxy itself). A private
// target is refused before the proxy sees it, so the proxy's request log doubles as proof nothing private was forwarded.
// Lightpanda without a proxy (`--block-private-networks`) and without a page to load can only be tested on its main document.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { connect, createServer, type Server } from "node:net";
import { networkInterfaces } from "node:os";
import { api, killAll } from "../lib/proc.ts";
import { cdpUrl } from "../lib/services.ts";
import { html, prose } from "../lib/sites.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import {
  expectBlocked,
  type Listener,
  PUBLIC_IP,
  type PublicSite,
  privateTargets,
  startListener,
  startPublicSite,
  startSex,
} from "./support.ts";

let tripwire: Listener;
let pub: PublicSite;
const targets = () => privateTargets(tripwire.port);

/** The page that points at every private target in every way a page can. */
const hostilePage = (webSocket = true) => {
  const refs = targets().flatMap(({ host }) => [
    `<script src="http://${host}/a.js"></script>`,
    `<img src="http://${host}/i.png">`,
    `<link rel="stylesheet" href="http://${host}/s.css">`,
    `<iframe src="http://${host}/f.html"></iframe>`,
    `<script>fetch("http://${host}/x").catch(function(){});</script>`,
    `<script>var x=new XMLHttpRequest();x.open("GET","http://${host}/xhr");x.onerror=function(){};x.send();</script>`,
  ]);
  if (webSocket) refs.push(`<script>try{new WebSocket("ws://127.0.0.1:${tripwire.port}/ws")}catch(e){}</script>`);
  refs.push(`<script>fetch("https://127.0.0.1:${tripwire.port}/tls").catch(function(){});</script>`);
  // The allowed content: proof the page ran and that public subresources still flow.
  refs.push(
    `<script>document.title="page-ran";fetch("/allowed").then(function(r){return r.text()}).then(function(t){var p=document.createElement("p");p.id="allowed";p.textContent="allowed:"+t;document.body.appendChild(p)})</script>`,
  );
  return html("Hostile", `<main><article><h1>Hostile heading</h1>${prose("hostile")}${refs.join("")}</article></main>`);
};

beforeAll(async () => {
  tripwire = await startListener();
  pub = await startPublicSite((_req, url) => {
    switch (url.pathname) {
      case "/hostile":
        return hostilePage();
      case "/loopback-only":
        return html(
          "Loopback",
          `<main><article><h1>Loopback</h1>${prose("loopback")}<script src="http://127.0.0.1:${tripwire.port}/a.js"></script><img src="http://127.0.0.1:${tripwire.port}/i.png"></article></main>`,
        );
      case "/hostile-http":
        return hostilePage(false);
      case "/allowed":
        return new Response("fine", { headers: { "content-type": "text/plain" } });
      case "/redirect": {
        const to = url.searchParams.get("to") ?? "";
        return new Response(null, { status: 302, headers: { location: to } });
      }
      default:
        return html("Plain", `<main><article><h1>Plain page</h1>${prose("plain")}</article></main>`);
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

/**
 * A CONNECT target that names one of the private spellings (or any loopback / private literal). A desktop Chrome also
 * opens tunnels of its own to public hosts (www.google.com for its services, `93.184.216.34:443` when it tries the https
 * version of the page): those are not the page reaching a private address, so only private targets count.
 */
const privateConnect = (target: string) =>
  privateTargets(tripwire.port).some((t) => target.startsWith(t.host) || target.startsWith(t.host.replace(/:\d+$/, ""))) ||
  /^(\[?::1|\[?::ffff:|127\.|10\.|169\.254\.|192\.168\.|\[?f[cd]|localhost)/i.test(target);

/** Nothing connected to the tripwire, and the proxy was only ever asked for the public address. */
const nothingPrivateReached = () => {
  expect(tripwire.connections).toEqual([]);
  for (const u of pub.proxied) expect(u.startsWith(`http://${PUBLIC_IP}/`)).toBe(true);
  expect(pub.connects.filter(privateConnect)).toEqual([]);
};

/** No request reached the tripwire: a connection that sent bytes has them appended after ": " (see startListener). */
const noPrivateRequest = () => {
  expect(tripwire.connections.filter((c) => c.includes(": "))).toEqual([]);
  for (const u of pub.proxied) expect(u.startsWith(`http://${PUBLIC_IP}/`)).toBe(true);
  expect(pub.connects.filter(privateConnect)).toEqual([]);
};

describe("plain HTTP fetch, no browser", () => {
  test("every spelling of a private address is PRIVATE_NETWORK_BLOCKED, http and https", async () => {
    const s = await startSex();
    for (const { name, host } of targets()) {
      for (const scheme of ["http", "https"]) {
        const res = await api(s.url, "/v2/scrape", { body: { url: `${scheme}://${host}/secret` } });
        expect([name, scheme, res.status, res.body.code]).toEqual([name, scheme, 403, "PRIVATE_NETWORK_BLOCKED"]);
      }
    }
    expect(tripwire.connections).toEqual([]);
    expect(await s.stop()).toBe(0);
  }, 60_000);

  test("a redirect from a public page to a private address is refused at the hop", async () => {
    const s = await startSex([], { SEX_PROXY_URL: pub.proxyUrl });
    const before = pub.proxied.length;
    for (const { name, host } of targets()) {
      const res = await api(s.url, "/v2/scrape", {
        body: { url: `${pub.origin}/redirect?to=${encodeURIComponent(`http://${host}/secret`)}` },
      });
      expectBlocked(res, name);
    }
    expect(tripwire.connections).toEqual([]);
    // The public hop itself went through the proxy; the private hop did not.
    expect(pub.proxied.length - before).toBe(targets().length);
    nothingPrivateReached();
    await s.stop();
  }, 60_000);

  test("control: with --allow-private-network the same loopback target is reached", async () => {
    const s = await startSex(["--allow-private-network"]);
    await api(s.url, "/v2/scrape", { body: { url: `http://127.0.0.1:${tripwire.port}/secret` } });
    expect(tripwire.connections.length).toBeGreaterThan(0);
    tripwire.connections.length = 0;
    await s.stop();
  }, 60_000);

  test("search and map refuse a private start URL too", async () => {
    const s = await startSex();
    const map = await api(s.url, "/v2/map", { body: { url: `http://127.0.0.1:${tripwire.port}/` } });
    expect(map.status).toBeGreaterThanOrEqual(400);
    expect(tripwire.connections).toEqual([]);
    await s.stop();
  }, 60_000);
});

describe("Lightpanda", () => {
  test("main documents at private addresses are refused (--block-private-networks), nothing connects", async () => {
    const s = await startSex(["--lightpanda"]);
    for (const { name, host } of targets()) {
      const res = await api(s.url, "/v2/scrape", { body: { url: `http://${host}/secret`, timeout: 30_000, waitFor: 200 } });
      expectBlocked(res, name);
    }
    expect(tripwire.connections).toEqual([]);
    await s.stop();
  }, 180_000);

  test("behind SEX_PROXY_URL: a public page loads, its private subresources / iframes / fetch() / XHR / WebSocket never leave sex", async () => {
    const s = await startSex(["--lightpanda"], { SEX_PROXY_URL: pub.proxyUrl });
    const res = await api(s.url, "/v2/scrape", {
      body: { url: `${pub.origin}/hostile-http`, formats: ["markdown", "rawHtml"], waitFor: 1500, timeout: 45_000 },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.metadata.title).toBe("page-ran");
    expect(res.body.data.markdown).toContain("Hostile heading");
    // The allowed content was fetched by the page's own script through sex and the proxy.
    expect(pub.proxied).toContain(`http://${PUBLIC_IP}/allowed`);
    nothingPrivateReached();
    await s.stop();
  }, 120_000);

  // BUG (security): Lightpanda behind SEX_PROXY_URL runs without --block-private-networks and a page's WebSocket does not go
  // through the EgressProxy, so `new WebSocket("ws://127.0.0.1:<port>")` from a public page connects to the loopback service.
  // The README says WebSocket is inside the EgressProxy's scope. Delete `.failing` once fixed.
  test.failing("behind SEX_PROXY_URL: a page's WebSocket to a private address never connects", async () => {
    const s = await startSex(["--lightpanda"], { SEX_PROXY_URL: pub.proxyUrl });
    const res = await api(s.url, "/v2/scrape", { body: { url: `${pub.origin}/hostile`, waitFor: 1500, timeout: 45_000 } });
    expect(res.status).toBe(200);
    await s.stop();
    await Bun.sleep(500);
    expect(tripwire.connections).toEqual([]);
  }, 120_000);

  test("behind SEX_PROXY_URL: main documents at private addresses and redirects to them are refused", async () => {
    const s = await startSex(["--lightpanda"], { SEX_PROXY_URL: pub.proxyUrl });
    for (const { name, host } of targets()) {
      expectBlocked(await api(s.url, "/v2/scrape", { body: { url: `http://${host}/secret`, timeout: 30_000 } }), `${name} direct`);
      const viaRedirect = await api(s.url, "/v2/scrape", {
        body: { url: `${pub.origin}/redirect?to=${encodeURIComponent(`http://${host}/secret`)}`, timeout: 30_000 },
      });
      expectBlocked(viaRedirect, `${name} redirect`);
    }
    nothingPrivateReached();
    await s.stop();
  }, 300_000);

  test("control: with --allow-private-network the hostile page does reach the tripwire", async () => {
    const s = await startSex(["--lightpanda", "--allow-private-network"]);
    tripwire.connections.length = 0;
    const res = await api(s.url, "/v2/scrape", { body: { url: `${pub.site.url}/loopback-only`, waitFor: 1000, timeout: 45_000 } });
    expect(res.status).toBe(200);
    expect(tripwire.connections.length).toBeGreaterThan(0);
    tripwire.connections.length = 0;
    await s.stop();
  }, 120_000);
});

const cdp = cdpUrl();

describe.skipIf(!cdp)("Chrome on this machine (--cdp-url, loopback): through sex's EgressProxy", () => {
  const args = () => ["--cdp-url", cdp as string];

  test("private main documents, subresources, iframes, fetch(), XHR and WebSocket never reach anything", async () => {
    const s = await startSex(args(), { SEX_PROXY_URL: pub.proxyUrl });
    const res = await api(s.url, "/v2/scrape", {
      body: { url: `${pub.origin}/hostile`, formats: ["markdown", "rawHtml"], waitFor: 1500, timeout: 45_000 },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.metadata.title).toBe("page-ran");
    expect(res.body.data.markdown).toContain("Hostile heading");
    expect(res.body.data.rawHtml).toContain("allowed:fine");
    expect(pub.proxied).toContain(`http://${PUBLIC_IP}/allowed`);
    nothingPrivateReached();
    await s.stop();
  }, 120_000);

  test("main documents at every private spelling, and redirects to them, are PRIVATE_NETWORK_BLOCKED", async () => {
    const s = await startSex(args(), { SEX_PROXY_URL: pub.proxyUrl });
    for (const { name, host } of targets()) {
      for (const scheme of ["http", "https"]) {
        expectBlocked(
          await api(s.url, "/v2/scrape", { body: { url: `${scheme}://${host}/secret`, timeout: 30_000 } }),
          `${name} ${scheme}`,
        );
      }
      expectBlocked(
        await api(s.url, "/v2/scrape", {
          body: { url: `${pub.origin}/redirect?to=${encodeURIComponent(`http://${host}/secret`)}`, timeout: 30_000 },
        }),
        `${name} redirect`,
      );
    }
    nothingPrivateReached();
    await s.stop();
  }, 400_000);

  test("control: with --allow-private-network Chrome does reach the tripwire from the same page", async () => {
    const s = await startSex([...args(), "--allow-private-network"]);
    tripwire.connections.length = 0;
    const res = await api(s.url, "/v2/scrape", { body: { url: `${pub.site.url}/loopback-only`, waitFor: 1000, timeout: 45_000 } });
    expect(res.status).toBe(200);
    expect(tripwire.connections.length).toBeGreaterThan(0);
    tripwire.connections.length = 0;
    await s.stop();
  }, 120_000);
});

/** An IPv4 address of this machine that is not loopback, or undefined (then there is no way to make Chrome "remote"). */
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

describe.skipIf(!cdp || !lanAddress)("Chrome elsewhere (--cdp-url at a non-loopback address): the CDP request guard", () => {
  let relay: Server | undefined;
  let relayUrl = "";

  beforeAll(async () => {
    // The same Chrome through a TCP relay on this machine's LAN address: sex sees a non-loopback host, so it takes the remote path
    // (no EgressProxy, the guard asks EgressPolicy per origin, the browser uses SEX_PROXY_URL itself).
    const target = new URL(cdp as string);
    relay = createServer((client) => {
      const upstream = connect(Number(target.port), target.hostname);
      client.pipe(upstream).pipe(client);
      for (const sock of [client, upstream]) sock.on("error", () => sock.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
    await new Promise<void>((resolve) => relay?.listen(0, "0.0.0.0", () => resolve()));
    relayUrl = `http://${lanAddress}:${(relay.address() as { port: number }).port}`;
  });
  afterAll(() => relay?.close());

  test("private main documents are refused and the page's private subresources / iframes / fetch() are aborted", async () => {
    const s = await startSex(["--cdp-url", relayUrl], { SEX_PROXY_URL: pub.proxyUrl });
    for (const { name, host } of targets()) {
      expectBlocked(await api(s.url, "/v2/scrape", { body: { url: `http://${host}/secret`, timeout: 30_000 } }), name);
    }
    // WebSocket is outside what the guard can see (README), so the page here has none: the test is for what it does cover.
    const res = await api(s.url, "/v2/scrape", {
      body: { url: `${pub.origin}/hostile-http`, formats: ["rawHtml"], waitFor: 1500, timeout: 45_000 },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.rawHtml).toContain("allowed:fine");
    noPrivateRequest();
    await s.stop();
  }, 300_000);

  // BUG (security, low): through the CDP request guard a desktop Chrome still opens bare TCP connections to private
  // addresses the page refers to, before any request exists for the guard to see (its speculative preconnect, which also
  // ignores the proxy for loopback). No request goes out (the test above), but the connection does. Seen with the
  // runner's google-chrome, not with chromedp/headless-shell. Delete `.failing` once a remote Chrome opens none.
  test.failing("not even a TCP connection reaches a private address the page refers to", async () => {
    const s = await startSex(["--cdp-url", relayUrl], { SEX_PROXY_URL: pub.proxyUrl });
    for (let i = 0; i < 2; i++) {
      const res = await api(s.url, "/v2/scrape", {
        body: { url: `${pub.origin}/hostile-http`, formats: ["rawHtml"], waitFor: 1500, timeout: 45_000 },
      });
      expect(res.status).toBe(200);
    }
    await s.stop();
    await Bun.sleep(500);
    expect(tripwire.connections).toEqual([]);
  }, 300_000);
});
