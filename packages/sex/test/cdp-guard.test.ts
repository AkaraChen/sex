import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deadline } from "@sex/core/deadline.ts";
import { resolvePublicAddresses } from "@sex/core/net.ts";
import { resolveConfig } from "../src/config.ts";
import { BrowserPool } from "../src/engine/browser.ts";
import { CdpGuard, cdpGuardSkipReason, type GuardResolver, isLoopbackHost } from "../src/engine/cdp-guard.ts";

describe("when the CDP guard proxy is used", () => {
  const on = { cdpUrl: "http://127.0.0.1:9222", allowPrivateNetwork: false };

  test("only for a local external CDP browser, with private networks refused and no upstream proxy", () => {
    expect(cdpGuardSkipReason(on)).toBeUndefined();
    expect(cdpGuardSkipReason({ ...on, cdpUrl: "ws://localhost:9222/devtools/browser/x" })).toBeUndefined();
    expect(cdpGuardSkipReason({ ...on, cdpUrl: "http://[::1]:9222" })).toBeUndefined();
    expect(cdpGuardSkipReason({ ...on, cdpUrl: undefined })).toContain("Lightpanda");
    expect(cdpGuardSkipReason({ ...on, cdpUrl: "http://chrome.internal:9222" })).toContain("not on this machine");
    expect(cdpGuardSkipReason({ ...on, allowPrivateNetwork: true })).toContain("private networks are allowed");
    expect(cdpGuardSkipReason({ ...on, proxyUrl: "http://proxy:3128" })).toContain("SEX_PROXY_URL");
  });

  test("loopback hosts", () => {
    for (const h of ["127.0.0.1", "127.9.9.9", "localhost", "[::1]", "::1", "LOCALHOST"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["10.0.0.1", "192.168.1.1", "128.0.0.1", "chrome", "0.0.0.0", "::2"]) expect(isLoopbackHost(h)).toBe(false);
  });
});

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

/** Sends raw bytes to the guard and returns what comes back until it closes (or `until` is seen). */
function raw(port: number, request: string, until?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    socket.setTimeout(5000, () => socket.destroy(new Error(`timeout; got ${JSON.stringify(out)}`)));
    socket.on("data", (d) => {
      out += d.toString();
      if (until && out.includes(until)) socket.destroy();
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(out));
  });
}
const status = (response: string) => Number(/^HTTP\/1\.\d (\d+)/.exec(response)?.[1]);

describe("CdpGuard", () => {
  let site: ReturnType<typeof Bun.serve>;
  const hits: string[] = [];
  let guard: CdpGuard;
  let session: ReturnType<CdpGuard["session"]>;
  let lookups: string[] = [];
  // Stands in for DNS: `pinned.invalid` validates to the local fixture (a name real DNS cannot answer, so a connect that looked
  // it up again would fail); `flip.invalid` is public once and private afterwards (rebinding); the rest is the real check.
  const resolve: GuardResolver = async (url, allowPrivate, requireResolvable) => {
    lookups.push(url.hostname);
    if (url.hostname === "pinned.invalid") return ["127.0.0.1"];
    if (url.hostname === "flip.invalid") {
      if (lookups.filter((h) => h === "flip.invalid").length === 1) return ["127.0.0.1"];
      return resolvePublicAddresses(new URL("http://10.0.0.1"), allowPrivate, requireResolvable);
    }
    return resolvePublicAddresses(url, allowPrivate, requireResolvable);
  };
  const get = (host: string, path = "/", auth = basic(session.credentials.username, session.credentials.password)) =>
    raw(guard.port, `GET http://${host}${path} HTTP/1.1\r\nHost: ${host}\r\nProxy-Authorization: ${auth}\r\nConnection: close\r\n\r\n`);

  beforeAll(async () => {
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        hits.push(new URL(req.url).pathname);
        return new Response("fixture says hi");
      },
    });
    guard = await CdpGuard.start(resolve);
    session = guard.session();
  });
  afterAll(async () => {
    await guard?.close();
    site?.stop(true);
  });

  test("listens on 127.0.0.1 only", async () => {
    expect(guard.port).toBeGreaterThan(0);
    expect(session.server).toBe(`http://127.0.0.1:${guard.port}`);
    expect(session.credentials.password.length).toBeGreaterThanOrEqual(24);
  });

  test("demands the process's credentials", async () => {
    const target = `127.0.0.1:${site.port}`;
    expect(status(await raw(guard.port, `GET http://${target}/x HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`))).toBe(407);
    expect(status(await get(target, "/x", basic(session.credentials.username, "wrong")))).toBe(407);
    expect(status(await get(target, "/x", basic("c999", session.credentials.password)))).toBe(407);
    expect(hits).toEqual([]);
  });

  test("refuses private targets and records the host for the session", async () => {
    session.blocked.length = 0;
    for (const host of [`127.0.0.1:${site.port}`, `localhost:${site.port}`, "169.254.169.254", "10.0.0.5:8080", "[::1]:9", "[fd00::1]:9"]) {
      const res = await get(host, "/secret");
      expect(status(res)).toBe(403);
      expect(res.toLowerCase()).toContain("x-sex-guard: blocked");
    }
    expect(session.blocked).toEqual(["127.0.0.1", "localhost", "169.254.169.254", "10.0.0.5", "::1", "fd00::1"]);
    expect(hits).toEqual([]);
  });

  test("refuses a CONNECT to a private target", async () => {
    const auth = basic(session.credentials.username, session.credentials.password);
    const res = await raw(
      guard.port,
      `CONNECT 127.0.0.1:${site.port} HTTP/1.1\r\nHost: 127.0.0.1:${site.port}\r\nProxy-Authorization: ${auth}\r\n\r\n`,
    );
    expect(status(res)).toBe(403);
    expect(hits).toEqual([]);
  });

  test("a name that does not resolve is refused, not looked up again by the connect", async () => {
    expect(status(await get("nonexistent-host.invalid:81"))).toBe(502);
  });

  test("connects to the validated address instead of resolving the name again (HTTP)", async () => {
    const res = await get(`pinned.invalid:${site.port}`, "/pinned");
    expect(status(res)).toBe(200);
    expect(res).toContain("fixture says hi");
    expect(hits).toEqual(["/pinned"]);
  });

  test("connects to the validated address instead of resolving the name again (CONNECT tunnel)", async () => {
    hits.length = 0;
    const auth = basic(session.credentials.username, session.credentials.password);
    const res = await raw(
      guard.port,
      `CONNECT pinned.invalid:${site.port} HTTP/1.1\r\nHost: pinned.invalid:${site.port}\r\nProxy-Authorization: ${auth}\r\n\r\n` +
        `GET /tunnel HTTP/1.1\r\nHost: pinned.invalid\r\nConnection: close\r\n\r\n`,
      "fixture says hi",
    );
    expect(res).toContain("200 Connection Established");
    expect(res).toContain("fixture says hi");
    expect(hits).toEqual(["/tunnel"]);
  });

  test("every request is checked again: a name that turned private is refused the second time (rebinding)", async () => {
    hits.length = 0;
    lookups = [];
    expect(status(await get(`flip.invalid:${site.port}`, "/first"))).toBe(200);
    expect(status(await get(`flip.invalid:${site.port}`, "/second"))).toBe(403);
    expect(hits).toEqual(["/first"]);
  });

  test("a released session is no longer accepted", async () => {
    const other = guard.session();
    other.release();
    const res = await get(`pinned.invalid:${site.port}`, "/", basic(other.credentials.username, other.credentials.password));
    expect(status(res)).toBe(407);
  });
});

// Opt-in, needs a running CDP browser on this machine (see browser.test.ts): what Chrome itself sends through the guard.
const CDP = process.env.SEX_TEST_CDP_URL;

describe.skipIf(!CDP)("CDP browser behind the guard proxy", () => {
  let a: ReturnType<typeof Bun.serve>;
  let b: ReturnType<typeof Bun.serve>;
  const aHits: string[] = [];
  const bHits: string[] = [];
  const pools: BrowserPool[] = [];
  const page = (body: string) =>
    new Response(`<!doctype html><html><head><title>Guarded</title></head><body><main><article>${body}</article></main></body></html>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  // The browser's own interception is switched off (everything allowed) so the guard proxy is what decides.
  const allowAll = async () => true;
  const resolve: GuardResolver = (url, allowPrivate, requireResolvable) =>
    url.hostname === "pinned.invalid" ? Promise.resolve(["127.0.0.1"]) : resolvePublicAddresses(url, allowPrivate, requireResolvable);

  function pool(overrides: { allowPrivateNetwork?: boolean } = {}): BrowserPool {
    const config = resolveConfig(
      { cdpUrl: CDP, concurrency: 2, timeout: 15_000, searxngUrl: "http://127.0.0.1:1", ...overrides },
      { allowPrivateNetwork: false },
      {},
    );
    const p = new BrowserPool(config, undefined, resolve);
    pools.push(p);
    return p;
  }
  const scrape = (p: BrowserPool, url: string) =>
    p.scrape({
      url,
      deadline: Deadline.start(15_000),
      userAgent: "sex-test",
      extract: { onlyMainContent: true, removeBase64Images: true, wantLinks: false, wantImages: false },
      requestGuard: allowAll,
    });

  beforeAll(() => {
    b = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        bHits.push(pathname);
        return pathname.endsWith(".js")
          ? new Response("window.internalLoaded = true", { headers: { "content-type": "application/javascript" } })
          : page("<p>secret internal text</p>");
      },
    });
    a = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        aHits.push(pathname);
        if (pathname === "/page") return page("<p>public page</p>");
        if (pathname === "/sub") {
          // Sub-resources a page could use to reach internal services: loopback, link-local (cloud metadata), a private range.
          return page(
            `<p>page with sub-resources</p><script src="http://127.0.0.1:${b.port}/loopback.js"></script>` +
              `<script src="http://localhost:${b.port}/localhost.js"></script>` +
              `<script src="http://169.254.169.254/latest/meta-data.js"></script><script src="http://10.255.255.1/lan.js"></script>` +
              `<img src="http://127.0.0.1:${b.port}/pixel.png">`,
          );
        }
        // The loopback script alone: without the guard the others would hang on addresses nobody answers.
        if (pathname === "/control") return page(`<p>control</p><script src="http://127.0.0.1:${b.port}/control.js"></script>`);
        return new Response("not found", { status: 404 });
      },
    });
  });
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.close()));
    a?.stop(true);
    b?.stop(true);
  });

  test("a page on a validated address loads through the guard", async () => {
    const res = await scrape(pool(), `http://pinned.invalid:${a.port}/page`);
    expect(res.extracted?.markdown).toContain("public page");
    expect(aHits).toContain("/page");
  });

  test("a private main document is refused as PRIVATE_NETWORK_BLOCKED and never reaches the server", async () => {
    bHits.length = 0;
    await expect(scrape(pool(), `http://127.0.0.1:${b.port}/secret`)).rejects.toMatchObject({ code: "PRIVATE_NETWORK_BLOCKED" });
    await expect(scrape(pool(), `http://localhost:${b.port}/secret`)).rejects.toMatchObject({ code: "PRIVATE_NETWORK_BLOCKED" });
    expect(bHits).toEqual([]);
  });

  test("private sub-resources of a public page are stopped at the network layer", async () => {
    bHits.length = 0;
    const res = await scrape(pool(), `http://pinned.invalid:${a.port}/sub`);
    expect(res.extracted?.markdown).toContain("page with sub-resources");
    expect(bHits).toEqual([]);
  });

  test("control: without the guard (private networks allowed) the same page does reach the internal server", async () => {
    bHits.length = 0;
    await scrape(pool({ allowPrivateNetwork: true }), `http://127.0.0.1:${a.port}/control`);
    expect(bHits).toContain("/control.js");
  });
});

// `bun build --minify` (what dist/sex is) renames classes; proxy-chain finds its own errors by class name.
describe("CdpGuard in a minified bundle", () => {
  test("still answers 407 to a client without credentials and 403 to a private target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sex-guard-bundle-"));
    try {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, "../src/engine/cdp-guard.ts")],
        root: join(import.meta.dir, "../.."),
        outdir: dir,
        minify: true,
        target: "bun",
      });
      expect(built.success).toBe(true);
      const script = `
        import { CdpGuard } from ${JSON.stringify(join(dir, "sex/src/engine/cdp-guard.js"))};
        import { connect } from "node:net";
        const g = await CdpGuard.start(); const s = g.session();
        const ask = (extra) => new Promise((res) => { let o = ""; const k = connect(g.port, "127.0.0.1", () => k.write("GET http://127.0.0.1:9/ HTTP/1.1\\r\\nHost: 127.0.0.1:9\\r\\n" + extra + "Connection: close\\r\\n\\r\\n")); k.on("data", (d) => (o += d)); k.on("close", () => res(o.split(" ")[1] + " " + /proxy-authenticate/i.test(o))); });
        console.log(await ask(""), await ask("Proxy-Authorization: Basic " + btoa(s.credentials.username + ":" + s.credentials.password) + "\\r\\n"));
        await g.close();
      `;
      const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "ignore" });
      expect((await new Response(proc.stdout).text()).trim()).toBe("407 true 403 false");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
