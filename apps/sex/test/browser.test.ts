import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserPool, pdeathsigWrapper } from "@searxng-js/sex-browser";
import { Deadline } from "@searxng-js/sex-deadline";
import { EgressPolicy } from "@searxng-js/sex-egress";
import { AppError } from "@searxng-js/sex-errors";
import type { ConfigOverrides } from "../src/config.ts";
import { browserOptions, type Engine } from "../src/engine/engine.ts";
import { testEngine, waitFor } from "./helpers.ts";

// Opt-in, needs a browser. Either an already running CDP browser:
//   SEX_TEST_CDP_URL=http://127.0.0.1:9333 bun test test/browser.test.ts
// or a Lightpanda binary that sex spawns itself (also runs the child process lifecycle tests below):
//   SEX_TEST_LIGHTPANDA_PATH=/path/to/lightpanda bun test test/browser.test.ts
const CDP = process.env.SEX_TEST_CDP_URL;
const LIGHTPANDA = process.env.SEX_TEST_LIGHTPANDA_PATH;

const variants: Array<[name: string, overrides: ConfigOverrides]> = [];
if (CDP) variants.push(["cdp", { cdpUrl: CDP }]);
if (LIGHTPANDA) variants.push(["spawned lightpanda", { lightpanda: true, lightpandaPath: LIGHTPANDA }]);

const html = (body: string) =>
  `<!doctype html><html lang="en"><head><title>Browser Fixture</title></head><body><main><article>${body}</article></main></body></html>`;
/** Refuses everything but one port of this machine, the way a request guard would refuse a private origin. */
class OnlyPort extends EgressPolicy {
  constructor(private readonly port: string | undefined) {
    super({ allowPrivateNetwork: false });
  }
  override async resolve(url: Pick<URL, "hostname" | "href">) {
    if (this.port !== undefined && new URL(url.href).port !== this.port)
      throw new AppError("PRIVATE_NETWORK_BLOCKED", `refused ${url.href}`);
    return [];
  }
}

const extract = { onlyMainContent: true, removeBase64Images: true, wantLinks: false, wantImages: false };

describe.each(variants)("browser (%s)", (_name, overrides) => {
  let a: ReturnType<typeof Bun.serve>;
  let b: ReturnType<typeof Bun.serve>;
  let bHits: string[] = [];
  /** Headers of every request each server received, by path. */
  let aHeaders: Record<string, Headers> = {};
  let bHeaders: Record<string, Headers> = {};
  let engine: Engine;
  const origin = () => `http://127.0.0.1:${a.port}`;
  /** The request-guard route (a browser elsewhere): CDP interception asks the policy about every request. */
  let guardedA: BrowserPool;
  let guardedAll: BrowserPool;

  beforeAll(() => {
    // Server B stands in for an internal address: every hit is recorded.
    b = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        bHits.push(new URL(req.url).pathname);
        bHeaders[new URL(req.url).pathname] = req.headers;
        if (new URL(req.url).pathname === "/cdn.js")
          return new Response("window.cdnLoaded = true", { headers: { "content-type": "application/javascript" } });
        if (new URL(req.url).pathname === "/pixel.png")
          return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
        return new Response(html("<p>secret internal text</p>"), { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    });
    a = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        aHeaders[pathname] = req.headers;
        switch (pathname) {
          case "/page":
            return new Response(html(`<h1>Fixture heading</h1><p>Hello from the browser fixture.</p><a href="/other">Other page</a>`), {
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          case "/other":
            return new Response(html("<p>other</p>"), { headers: { "content-type": "text/html; charset=utf-8" } });
          case "/redirect":
            return Response.redirect(`http://127.0.0.1:${b.port}/secret`, 302);
          case "/creds":
            // /same.js is the target's own origin; localhost is a different origin (host) on the same machine.
            return new Response(
              html(`<p>Credentials page</p><script src="/same.js"></script><script src="http://localhost:${b.port}/cdn.js"></script>`),
              { headers: { "content-type": "text/html; charset=utf-8" } },
            );
          case "/same.js":
            return new Response("window.sameLoaded = true", { headers: { "content-type": "application/javascript" } });
          case "/to-other":
            return Response.redirect(`http://localhost:${b.port}/landing`, 302);
          case "/img":
            return new Response(html(`<p>Image page</p><img src="http://127.0.0.1:${b.port}/pixel.png">`), {
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          default:
            return new Response("not found", { status: 404 });
        }
      },
    });
    engine = testEngine(overrides);
    guardedA = new BrowserPool({ ...browserOptions(engine.config), kind: "remote-cdp", policy: new OnlyPort(String(a.port)) });
    guardedAll = new BrowserPool({ ...browserOptions(engine.config), kind: "remote-cdp", policy: new OnlyPort(undefined) });
  });

  afterAll(async () => {
    await Promise.all([guardedA?.close(), guardedAll?.close()]);
    await engine?.browser.close();
    a?.stop(true);
    b?.stop(true);
  });

  test("scrapes a page through the browser into markdown and links", async () => {
    const doc = await engine.scrape({ url: `${origin()}/page`, formats: ["markdown", "links"] });
    expect(doc.markdown).toContain("Hello from the browser fixture");
    expect(doc.links).toContain(`${origin()}/other`);
  });

  test("runs actions: javascript return values and page html snapshots", async () => {
    const doc = await engine.scrape({
      url: `${origin()}/page`,
      formats: ["markdown"],
      actions: [{ type: "executeJavascript", script: "return document.title" }, { type: "scrape" }],
    });
    expect(doc.actions?.javascriptReturns[0]?.value).toBe("Browser Fixture");
    expect(doc.actions?.scrapes[0]?.html).toContain("<html");
  });

  describe("deadline", () => {
    const rejected = async (p: Promise<unknown>) =>
      p.then(
        () => undefined,
        (e: unknown) => e,
      );
    const took = async (p: Promise<unknown>) => {
      const t0 = performance.now();
      const err = await rejected(p);
      return { err, ms: performance.now() - t0 };
    };

    test("waitFor longer than the timeout ends at the timeout as SCRAPE_TIMEOUT, and the slot is free again", async () => {
      const { err, ms } = await took(engine.scrape({ url: `${origin()}/page`, waitFor: 30_000, timeout: 1500 }));
      expect(err).toMatchObject({ status: 408, code: "SCRAPE_TIMEOUT" });
      expect(ms).toBeLessThan(4000);
      const doc = await engine.scrape({ url: `${origin()}/page`, formats: ["markdown"] });
      expect(doc.markdown).toContain("Hello from the browser fixture");
    });

    test("wait actions count against the timeout", async () => {
      const { err, ms } = await took(
        engine.scrape({ url: `${origin()}/page`, actions: [{ type: "wait", milliseconds: 20_000 }], timeout: 1500 }),
      );
      expect(err).toMatchObject({ status: 408, code: "SCRAPE_TIMEOUT" });
      expect(ms).toBeLessThan(4000);
    });

    test("waiting for a selector that never shows up ends at the timeout", async () => {
      const { err, ms } = await took(
        engine.scrape({ url: `${origin()}/page`, actions: [{ type: "wait", selector: "#never" }], timeout: 1500 }),
      );
      expect(err).toMatchObject({ status: 408, code: "SCRAPE_TIMEOUT" });
      expect(ms).toBeLessThan(4000);
    });

    test("a script that never returns ends at the timeout", async () => {
      const { err, ms } = await took(
        engine.scrape({
          url: `${origin()}/page`,
          actions: [{ type: "executeJavascript", script: "return await new Promise(() => {})" }],
          timeout: 1500,
        }),
      );
      expect(err).toMatchObject({ status: 408, code: "SCRAPE_TIMEOUT" });
      expect(ms).toBeLessThan(4000);
    });

    test("a cancelled caller is TIMEOUT and releases the browser", async () => {
      const caller = new AbortController();
      setTimeout(() => caller.abort(), 300);
      const { err, ms } = await took(engine.scrape({ url: `${origin()}/page`, waitFor: 30_000, timeout: 60_000 }, caller.signal));
      expect(err).toMatchObject({ status: 408, code: "TIMEOUT" });
      expect(ms).toBeLessThan(3000);
    });

    test("a waitFor of more than half the timeout is allowed but warned about", async () => {
      const doc = await engine.scrape({ url: `${origin()}/page`, formats: ["markdown"], waitFor: 600, timeout: 1000 });
      expect(doc.markdown).toContain("Hello from the browser fixture");
      expect(doc.warning).toContain("waitFor");
    });

    test("a refused connection is SCRAPE_SITE_ERROR", async () => {
      const err = await rejected(engine.scrape({ url: "http://127.0.0.1:1/" }));
      expect(err).toMatchObject({ status: 500, code: "SCRAPE_SITE_ERROR" });
    });

    test("an unknown host is SCRAPE_DNS_RESOLUTION_ERROR", async () => {
      const err = await rejected(engine.scrape({ url: "http://no-such-host.invalid/" }));
      expect(err).toMatchObject({ status: 500, code: "SCRAPE_DNS_RESOLUTION_ERROR" });
    });
  });

  test("blocks a redirect to a non-allowed address before its content is fetched", async () => {
    const err = await guardedA
      .scrape({ url: `${origin()}/redirect`, ...Deadline.start(10_000).time(), userAgent: "t", extract })
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("PRIVATE_NETWORK_BLOCKED");
    expect(bHits).toEqual([]);
  });

  describe("user credentials", () => {
    const headers = { Authorization: "Bearer secret-token", Cookie: "sid=abc123; theme=dark", "X-Plain": "1" };
    const scrape = (path: string, extra: Partial<Parameters<Engine["browser"]["scrape"]>[0]> = {}, pool = engine.browser) => {
      aHeaders = {};
      bHeaders = {};
      return pool.scrape({
        url: `${origin()}${path}`,
        ...Deadline.start(10_000).time(),
        userAgent: "t",
        extract,
        headers,
        ...extra,
      });
    };

    test("reach the target's origin, its subresources, and no other origin", async () => {
      const result = await scrape("/creds");
      expect(result.rawHtml).toContain("Credentials page");
      for (const path of ["/creds", "/same.js"]) {
        expect(aHeaders[path]?.get("authorization")).toBe("Bearer secret-token");
        expect(aHeaders[path]?.get("cookie")).toBe("sid=abc123; theme=dark");
        expect(aHeaders[path]?.get("x-plain")).toBe("1");
      }
      // Same machine, different host: a third party as far as the browser is concerned.
      expect(bHeaders["/cdn.js"]).toBeDefined();
      expect(bHeaders["/cdn.js"]?.get("authorization")).toBeNull();
      expect(bHeaders["/cdn.js"]?.get("cookie")).toBeNull();
      expect(bHeaders["/cdn.js"]?.get("proxy-authorization")).toBeNull();
    });

    test("do not follow a redirect to another origin", async () => {
      const result = await scrape("/to-other");
      expect(result.rawHtml).toContain("secret internal text");
      expect(bHeaders["/landing"]).toBeDefined();
      expect(bHeaders["/landing"]?.get("authorization")).toBeNull();
      expect(bHeaders["/landing"]?.get("cookie")).toBeNull();
    });

    test("work next to the private-network guard", async () => {
      const result = await scrape("/creds", {}, guardedAll);
      expect(result.rawHtml).toContain("Credentials page");
      expect(aHeaders["/same.js"]?.get("authorization")).toBe("Bearer secret-token");
      expect(bHeaders["/cdn.js"]?.get("authorization")).toBeNull();
      // The guard still decides first: a refused origin is not contacted, with or without credentials.
      bHits = [];
      await scrape("/creds", {}, guardedA);
      expect(bHits).toEqual([]);
    });

    test("work next to ad blocking: nothing on the page is an ad, so everything is loaded", async () => {
      const result = await scrape("/creds", { blockAds: true });
      expect(result.rawHtml).toContain("Credentials page");
      expect(result.adsBlocked).toBe(0);
      expect(aHeaders["/same.js"]?.get("authorization")).toBe("Bearer secret-token");
      expect(bHeaders["/cdn.js"]).toBeDefined();
    });

    test("the cookie arrives intact (it lives in the cookie jar, not in a request header)", async () => {
      await scrape("/page", { headers: { Cookie: "token=a=b==; short=x" } });
      expect(aHeaders["/page"]?.get("cookie")).toBe("token=a=b==; short=x");
    });
  });

  test("blocks subresources to a non-allowed address without failing the page", async () => {
    bHits = [];
    const result = await guardedA.scrape({
      url: `${origin()}/img`,
      ...Deadline.start(10_000).time(),
      userAgent: "t",
      extract,
    });
    expect(result.rawHtml).toContain("Image page");
    expect(bHits).toEqual([]);
  });
});

/** True while the process exists and is not a zombie. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true; // no /proc (macOS): the signal check above is all there is
  }
}

describe.skipIf(!LIGHTPANDA)("spawned lightpanda process", () => {
  let site: ReturnType<typeof Bun.serve>;
  let hits = 0;
  let engine: Engine | undefined;
  const spawning = (overrides: ConfigOverrides = {}) =>
    (engine = testEngine({ lightpanda: true, lightpandaPath: LIGHTPANDA, ...overrides }));
  const scrape = (e: Engine) => e.scrape({ url: `http://127.0.0.1:${site.port}/`, formats: ["markdown"] });

  beforeAll(() => {
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        hits++;
        return new Response(html("<h1>Lifecycle</h1><p>Hello from the lifecycle fixture.</p>"), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    });
  });

  afterEach(async () => {
    await engine?.close();
    engine = undefined;
  });

  afterAll(() => site.stop(true));

  test("the first browser scrape spawns the child", async () => {
    const e = spawning();
    expect(e.browser.pid).toBeUndefined();
    const doc = await scrape(e);
    expect(doc.markdown).toContain("Hello from the lifecycle fixture");
    const pid = e.browser.pid;
    expect(pid).toBeNumber();
    expect(alive(pid!)).toBe(true);
  });

  test("killing the child makes the next scrape spawn a new one", async () => {
    const e = spawning();
    await scrape(e);
    const first = e.browser.pid!;
    process.kill(first, "SIGKILL");
    await waitFor(() => (e.browser.pid === undefined ? true : undefined));
    expect((await scrape(e)).markdown).toContain("Hello from the lifecycle fixture");
    const second = e.browser.pid!;
    expect(second).not.toBe(first);
    expect(alive(second)).toBe(true);
    expect(alive(first)).toBe(false);
  });

  test("engine.close() leaves no child process", async () => {
    const e = spawning();
    await scrape(e);
    const pid = e.browser.pid!;
    await e.close();
    expect(e.browser.pid).toBeUndefined();
    expect(alive(pid)).toBe(false);
  });

  test.skipIf(!pdeathsigWrapper())(
    "the child exits when sex is killed with SIGKILL",
    async () => {
      const script = `
        import { testEngine } from ${JSON.stringify(join(import.meta.dir, "helpers.ts"))};
        const engine = testEngine({ lightpanda: true, lightpandaPath: ${JSON.stringify(LIGHTPANDA)} });
        await engine.browser.warmup();
        console.log(engine.browser.pid);
        await Bun.sleep(60_000);
      `;
      // The child resolves the workspace packages from source like the test itself (CI builds no dist for this job).
      const parent = Bun.spawn([process.execPath, "--conditions", "sex-source", "-e", script], { stdout: "pipe", stderr: "pipe" });
      let pid = 0;
      try {
        // The first line the script prints is the PID of its Lightpanda child.
        const reader = parent.stdout.getReader();
        const decoder = new TextDecoder();
        let out = "";
        while (!out.includes("\n")) {
          const { value, done } = await reader.read();
          if (done) break;
          out += decoder.decode(value, { stream: true });
        }
        pid = Number(out.trim());
        // A script that died before printing gives no PID; process.kill(0, 0) would then probe our own process group.
        if (!Number.isInteger(pid) || pid <= 0)
          throw new Error(`no Lightpanda PID from the child: ${await new Response(parent.stderr).text()}`);
        expect(alive(pid)).toBe(true);
        parent.kill("SIGKILL");
        await parent.exited;
        await waitFor(() => (alive(pid) ? undefined : true), 5_000);
      } finally {
        parent.kill("SIGKILL");
        if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      }
    },
    20_000,
  );

  test("lightpanda itself refuses private addresses when they are not allowed", async () => {
    const e = spawning({ allowPrivateNetwork: false });
    hits = 0;
    // Only the child's --block-private-networks stands between the page and the loopback fixture.
    const err = await e.browser
      .scrape({ url: `http://127.0.0.1:${site.port}/`, ...Deadline.start(10_000).time(), userAgent: "t", extract })
      .catch((x: unknown) => x);
    expect(err).toMatchObject({ code: "SCRAPE_SITE_ERROR" });
    expect(hits).toBe(0);
  });
});
