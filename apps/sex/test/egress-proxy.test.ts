import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgressPolicy } from "@sex/core/egress.ts";
import { AdBlockList } from "../src/engine/adblock.ts";
import { EGRESS_HEADER, type EgressLease, EgressProxy } from "../src/engine/egress-proxy.ts";

// No browser needed: requests are made straight at the proxy, the way a browser would make them.

/** A policy that, for names a test declares, answers what `EgressPolicy` would after validating a public address. */
class FakePublicNames extends EgressPolicy {
  constructor(
    private readonly names: Record<string, string[]>,
    opts: ConstructorParameters<typeof EgressPolicy>[0] = { allowPrivateNetwork: false },
  ) {
    super(opts);
  }
  override async resolve(url: Pick<URL, "hostname" | "href">, requireResolvable = false) {
    return this.names[url.hostname] ?? super.resolve(url, requireResolvable);
  }
}

interface Hit {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

/** Records every request; answers by path. */
function startServer(host = "127.0.0.1") {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    const path = req.url ?? "";
    if (path.startsWith("/redirect")) return void res.writeHead(302, { location: `http://127.0.0.1:${hits.length}/elsewhere` }).end();
    if (path.startsWith("/cookies"))
      return void res.writeHead(200, { "set-cookie": ["a=1", "b=2"], "x-hop": "1", connection: "keep-alive, x-hop" }).end("ok");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => res.writeHead(200, { "content-type": "text/plain" }).end(`${req.method} ${path} ${body}`));
  });
  return new Promise<{ port: number; hits: Hit[]; close: () => void }>((resolve) =>
    server.listen(0, host, () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        hits,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      }),
    ),
  );
}

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

/** A plain-http request in absolute form, as a browser sends it to a proxy. */
function viaProxy(
  proxyUrl: string,
  target: string,
  opts: { auth?: string; method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  const proxy = new URL(proxyUrl);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; rawSetCookie: string[]; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: proxy.hostname,
        port: proxy.port,
        method: opts.method ?? "GET",
        path: target,
        agent: false,
        headers: {
          host: target.startsWith("/") ? "origin-form" : new URL(target).host,
          ...(opts.auth ? { "proxy-authorization": opts.auth } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, rawSetCookie: res.headers["set-cookie"] ?? [], body }),
        );
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

/** CONNECT to `authority`; resolves with the proxy's status and, on 200, the open tunnel. */
function connectTo(proxyUrl: string, authority: string, auth?: string) {
  const proxy = new URL(proxyUrl);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; socket: Socket }>((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: proxy.port,
      method: "CONNECT",
      path: authority,
      agent: false,
      headers: { host: authority, ...(auth ? { "proxy-authorization": auth } : {}) },
    });
    req.once("connect", (res, socket) => resolve({ status: res.statusCode ?? 0, headers: res.headers, socket }));
    req.on("error", reject);
    req.end();
  });
}

/** Sends an HTTP/1.0 request through an open tunnel and reads the answer to the end. */
function throughTunnel(socket: Socket, path: string, host: string): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    socket.on("data", (c) => (out += c));
    socket.on("close", () => resolve(out));
    socket.write(`GET ${path} HTTP/1.0\r\nhost: ${host}\r\n\r\n`);
  });
}

describe("EgressProxy", () => {
  let site: Awaited<ReturnType<typeof startServer>>;
  let internal: Awaited<ReturnType<typeof startServer>>;
  let proxy: EgressProxy;
  let lease: EgressLease;
  const auth = () => basic(lease.credentials.username, lease.credentials.password);
  const names = () => ({ "site.test": ["127.0.0.1"] });

  beforeAll(async () => {
    site = await startServer();
    internal = await startServer();
  });
  afterAll(() => {
    site.close();
    internal.close();
  });
  beforeEach(async () => {
    site.hits.length = 0;
    internal.hits.length = 0;
    proxy = new EgressProxy(new FakePublicNames(names()));
    lease = await proxy.open();
  });
  afterEach(async () => {
    lease.close();
    await proxy.close();
  });

  describe("authentication", () => {
    test("a request without credentials gets 407 and reaches nothing", async () => {
      const res = await viaProxy(lease.server, `http://site.test:${site.port}/x`);
      expect(res.status).toBe(407);
      expect(res.headers["proxy-authenticate"]).toContain("Basic");
      expect((await connectTo(lease.server, `site.test:${site.port}`)).status).toBe(407);
      expect(site.hits).toEqual([]);
    });

    test("wrong password, wrong user and a different scheme are 407", async () => {
      const target = `http://site.test:${site.port}/x`;
      for (const header of [
        basic(lease.credentials.username, "nope"),
        basic("nope", lease.credentials.password),
        `Bearer ${lease.credentials.password}`,
        "Basic !!!",
      ]) {
        expect((await viaProxy(lease.server, target, { auth: header })).status).toBe(407);
        expect((await connectTo(lease.server, `site.test:${site.port}`, header)).status).toBe(407);
      }
      expect(site.hits).toEqual([]);
    });

    test("the right credentials work, for http and for CONNECT", async () => {
      const res = await viaProxy(lease.server, `http://site.test:${site.port}/x`, { auth: auth() });
      expect([res.status, res.body]).toEqual([200, "GET /x "]);
      const tunnel = await connectTo(lease.server, `site.test:${site.port}`, auth());
      expect(tunnel.status).toBe(200);
      expect(await throughTunnel(tunnel.socket, "/t", `site.test:${site.port}`)).toContain("GET /t");
    });

    test("credentials of another lease do not work, and a closed lease's stop working", async () => {
      const other = await proxy.open();
      expect(
        (
          await viaProxy(lease.server, `http://site.test:${site.port}/x`, {
            auth: basic(other.credentials.username, lease.credentials.password),
          })
        ).status,
      ).toBe(407);
      const stale = auth();
      lease.close();
      expect((await viaProxy(lease.server, `http://site.test:${site.port}/x`, { auth: stale })).status).toBe(407);
      expect((await connectTo(lease.server, `site.test:${site.port}`, stale)).status).toBe(407);
      expect(site.hits).toEqual([]);
      other.close();
    });

    test("ending a lease closes its open tunnels, not another lease's", async () => {
      const other = await proxy.open();
      const mine = await connectTo(lease.server, `site.test:${site.port}`, auth());
      const theirs = await connectTo(other.server, `site.test:${site.port}`, basic(other.credentials.username, other.credentials.password));
      const closed = new Promise<void>((resolve) => mine.socket.once("close", () => resolve()));
      lease.close();
      await closed;
      expect(theirs.socket.destroyed).toBe(false);
      theirs.socket.destroy();
      other.close();
    });

    test("a request that is not a proxy request (origin-form) is refused after authentication", async () => {
      const res = await viaProxy(lease.server, "/just-a-path", { auth: auth() });
      expect(res.status).toBe(400);
    });
  });

  describe("private targets", () => {
    const targets = () => [
      `127.0.0.1:${internal.port}`,
      `localhost:${internal.port}`,
      `[::1]:${internal.port}`,
      `169.254.169.254:80`,
      `[fd00::1]:80`,
      `10.0.0.1:80`,
      `[::ffff:127.0.0.1]:${internal.port}`,
    ];

    test("http: refused with 403 and the internal service receives nothing", async () => {
      for (const authority of targets()) {
        const res = await viaProxy(lease.server, `http://${authority}/secret`, { auth: auth() });
        expect([authority, res.status, res.headers[EGRESS_HEADER]]).toEqual([authority, 403, "refused"]);
      }
      expect(internal.hits).toEqual([]);
    });

    test("CONNECT: refused with 403 and the internal service receives nothing", async () => {
      for (const authority of targets()) {
        const res = await connectTo(lease.server, authority, auth());
        expect([authority, res.status, res.headers[EGRESS_HEADER]]).toEqual([authority, 403, "refused"]);
        res.socket.destroy();
      }
      expect(internal.hits).toEqual([]);
    });

    test("a name that resolves to a private address is refused, and so is one with a private address among public ones", async () => {
      const policy = new EgressPolicy({
        allowPrivateNetwork: false,
        resolver: async (host) => (host === "mixed.test" ? ["93.184.216.34", "127.0.0.1"] : ["127.0.0.1"]),
      });
      const strict = new EgressProxy(policy);
      const l = await strict.open();
      const header = basic(l.credentials.username, l.credentials.password);
      for (const host of ["internal.test", "mixed.test"]) {
        expect((await viaProxy(l.server, `http://${host}:${internal.port}/`, { auth: header })).status).toBe(403);
        expect((await connectTo(l.server, `${host}:${internal.port}`, header)).status).toBe(403);
      }
      expect(internal.hits).toEqual([]);
      expect(l.failureOf("internal.test")).toBe("refused");
      l.close();
      await strict.close();
    });

    test("with private networks allowed nothing is refused", async () => {
      const open = new EgressProxy(new EgressPolicy({ allowPrivateNetwork: true }));
      const l = await open.open();
      const res = await viaProxy(l.server, `http://127.0.0.1:${internal.port}/ok`, {
        auth: basic(l.credentials.username, l.credentials.password),
      });
      expect([res.status, res.body]).toEqual([200, "GET /ok "]);
      l.close();
      await open.close();
    });

    test("a name that does not resolve is a 502 the lease remembers", async () => {
      const policy = new EgressPolicy({ allowPrivateNetwork: false, resolver: async () => [] });
      const p = new EgressProxy(policy);
      const l = await p.open({ upstream: "http://127.0.0.1:9" }); // an upstream makes resolving here mandatory
      const res = await viaProxy(l.server, "http://nowhere.test/", { auth: basic(l.credentials.username, l.credentials.password) });
      expect([res.status, res.headers[EGRESS_HEADER]]).toEqual([502, "dns"]);
      expect(l.failureOf("nowhere.test")).toBe("dns");
      l.close();
      await p.close();
    });
  });

  describe("pinning", () => {
    test("connects to the address the policy validated and never looks the name up again", async () => {
      // pinned.test does not exist in DNS: the request can only arrive if the validated address was used.
      const pinnedProxy = new EgressProxy(new FakePublicNames({ "pinned.test": ["127.0.0.1"] }));
      const l = await pinnedProxy.open();
      const header = basic(l.credentials.username, l.credentials.password);
      const res = await viaProxy(l.server, `http://pinned.test:${site.port}/p`, { auth: header });
      expect([res.status, res.body]).toEqual([200, "GET /p "]);
      expect(site.hits[0]?.headers.host).toBe(`pinned.test:${site.port}`);
      const tunnel = await connectTo(l.server, `pinned.test:${site.port}`, header);
      expect(tunnel.status).toBe(200);
      expect(await throughTunnel(tunnel.socket, "/t", "pinned.test")).toContain("GET /t");
      l.close();
      await pinnedProxy.close();
    });

    test("tries the next validated address when the first refuses the connection", async () => {
      const dead = await startServer();
      const deadPort = dead.port;
      dead.close();
      const p = new EgressProxy(new FakePublicNames({ "multi.test": ["127.0.0.2", "127.0.0.1"] }));
      const l = await p.open();
      const header = basic(l.credentials.username, l.credentials.password);
      // 127.0.0.2 has nothing on this port in the first case either; the server listens on 127.0.0.1 only.
      expect((await viaProxy(l.server, `http://multi.test:${site.port}/m`, { auth: header })).body).toBe("GET /m ");
      expect((await connectTo(l.server, `multi.test:${site.port}`, header)).status).toBe(200);
      expect((await viaProxy(l.server, `http://multi.test:${deadPort}/m`, { auth: header })).status).toBe(502);
      l.close();
      await p.close();
    });
  });

  describe("forwarding", () => {
    test("hop-by-hop and proxy headers are not forwarded, others are, Host stays", async () => {
      await viaProxy(lease.server, `http://site.test:${site.port}/h`, {
        auth: auth(),
        headers: {
          connection: "keep-alive, x-drop",
          "x-drop": "named by Connection",
          "keep-alive": "timeout=5",
          "proxy-connection": "keep-alive",
          te: "trailers",
          upgrade: "h2c",
          "x-keep": "yes",
          "accept-language": "de",
        },
      });
      const headers = site.hits[0]?.headers ?? {};
      expect(headers["x-keep"]).toBe("yes");
      expect(headers["accept-language"]).toBe("de");
      expect(headers.host).toBe(`site.test:${site.port}`);
      for (const name of ["proxy-authorization", "proxy-connection", "x-drop", "keep-alive", "te", "upgrade"]) {
        expect([name, headers[name]]).toEqual([name, undefined]);
      }
    });

    test("response hop-by-hop headers are dropped, repeated headers survive", async () => {
      const res = await viaProxy(lease.server, `http://site.test:${site.port}/cookies`, { auth: auth() });
      expect(res.rawSetCookie).toEqual(["a=1", "b=2"]);
      expect(res.headers["x-hop"]).toBeUndefined();
    });

    test("a redirect is passed on as it is, not followed", async () => {
      const res = await viaProxy(lease.server, `http://site.test:${site.port}/redirect`, { auth: auth() });
      expect(res.status).toBe(302);
      expect(res.headers.location).toStartWith("http://127.0.0.1:");
      expect(site.hits.map((h) => h.url)).toEqual(["/redirect"]);
    });

    test("the redirect's target is checked when the browser follows it", async () => {
      const res = await viaProxy(lease.server, `http://127.0.0.1:${internal.port}/elsewhere`, { auth: auth() });
      expect(res.status).toBe(403);
      expect(internal.hits).toEqual([]);
    });

    test("a request body arrives intact", async () => {
      const res = await viaProxy(lease.server, `http://site.test:${site.port}/post`, {
        auth: auth(),
        method: "POST",
        body: "payload",
        headers: { "content-length": "7" },
      });
      expect(res.body).toBe("POST /post payload");
    });

    test("an unreachable origin is a 502 with the proxy's marker", async () => {
      const gone = await startServer();
      const port = gone.port;
      gone.close();
      const res = await viaProxy(lease.server, `http://site.test:${port}/`, { auth: auth() });
      expect([res.status, res.headers[EGRESS_HEADER]]).toEqual([502, "upstream"]);
    });
  });

  describe("tunnels", () => {
    test("bytes flow both ways and a close on one side closes the other", async () => {
      const echo = net.createServer((s) => s.on("data", (d) => s.write(`echo:${d}`)));
      await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
      const port = (echo.address() as net.AddressInfo).port;
      const tunnel = await connectTo(lease.server, `site.test:${port}`, auth());
      const got = new Promise<string>((r) => tunnel.socket.once("data", (d) => r(String(d))));
      tunnel.socket.write("hello");
      expect(await got).toBe("echo:hello");
      const closed = new Promise<void>((r) => tunnel.socket.once("close", () => r()));
      echo.close();
      tunnel.socket.end();
      await closed;
    });

    test("a tunnel with no traffic is dropped after the idle timeout", async () => {
      const quick = new EgressProxy(new FakePublicNames(names()), 150);
      const l = await quick.open();
      const tunnel = await connectTo(l.server, `site.test:${site.port}`, basic(l.credentials.username, l.credentials.password));
      const closed = new Promise<void>((r) => tunnel.socket.once("close", () => r()));
      await closed;
      l.close();
      await quick.close();
    });

    test("a malformed CONNECT target is a 400", async () => {
      expect((await connectTo(lease.server, "no-port", auth())).status).toBe(400);
      expect((await connectTo(lease.server, "site.test:99999", auth())).status).toBe(400);
    });
  });

  describe("ad blocking", () => {
    const list = AdBlockList.parse("tracker.test\n~social.test\n@ok.tracker.test\n");

    test("an ad domain is refused before any lookup, http and CONNECT, and counted", async () => {
      const p = new EgressProxy(
        new FakePublicNames(
          { "tracker.test": ["127.0.0.1"], "ok.tracker.test": ["127.0.0.1"], "page.test": ["127.0.0.1"] },
          { allowPrivateNetwork: false },
        ),
      );
      const l = await p.open({ adBlock: { list, pageUrl: `http://page.test:${site.port}/` } });
      const header = basic(l.credentials.username, l.credentials.password);
      const res = await viaProxy(l.server, `http://tracker.test:${site.port}/t.js`, { auth: header });
      expect([res.status, res.headers[EGRESS_HEADER]]).toEqual([403, "ad"]);
      expect((await connectTo(l.server, "sub.tracker.test:443", header)).status).toBe(403);
      expect(l.adsBlocked()).toBe(2);
      // An exception rule wins, and the page's own host is never refused.
      expect((await viaProxy(l.server, `http://ok.tracker.test:${site.port}/ok`, { auth: header })).status).toBe(200);
      expect(site.hits.map((h) => h.url)).toEqual(["/ok"]);
      // A third-party-only rule does not apply to the page's own site.
      expect((await viaProxy(l.server, `http://page.test:${site.port}/`, { auth: header })).status).toBe(200);
      l.close();
      await p.close();
    });

    test("a page on a listed domain can still be scraped", async () => {
      const p = new EgressProxy(new FakePublicNames({ "tracker.test": ["127.0.0.1"] }));
      const l = await p.open({ adBlock: { list, pageUrl: `http://tracker.test:${site.port}/` } });
      const res = await viaProxy(l.server, `http://tracker.test:${site.port}/page`, {
        auth: basic(l.credentials.username, l.credentials.password),
      });
      expect(res.status).toBe(200);
      l.close();
      await p.close();
    });

    test("without a list nothing is refused for being an ad", async () => {
      const res = await viaProxy(lease.server, `http://site.test:${site.port}/x`, { auth: auth() });
      expect(res.status).toBe(200);
      expect(lease.adsBlocked()).toBe(0);
    });
  });

  describe("upstream proxy", () => {
    /** An upstream that forwards absolute-form requests and tunnels CONNECT to the local fixture, recording what it sees. */
    function startUpstream(target: number) {
      const seen: Array<{ method: string; url: string; auth?: string }> = [];
      const server = http.createServer((req, res) => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers["proxy-authorization"] });
        if (req.headers["proxy-authorization"] !== basic("up", "p@ss:word")) return void res.writeHead(407).end();
        const out = http.request(
          {
            host: "127.0.0.1",
            port: target,
            path: new URL(req.url ?? "").pathname,
            method: req.method,
            headers: { host: req.headers.host },
          },
          (r) => {
            res.writeHead(r.statusCode ?? 502, r.headers);
            r.pipe(res);
          },
        );
        req.pipe(out);
      });
      server.on("connect", (req, socket) => {
        seen.push({ method: "CONNECT", url: req.url ?? "", auth: req.headers["proxy-authorization"] });
        if (req.headers["proxy-authorization"] !== basic("up", "p@ss:word"))
          return void socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        const out = net.connect(target, "127.0.0.1", () => {
          socket.write("HTTP/1.1 200 OK\r\n\r\n");
          out.pipe(socket);
          socket.pipe(out);
        });
        out.on("error", () => socket.destroy());
        socket.on("error", () => out.destroy());
      });
      return new Promise<{ url: string; seen: typeof seen; close: () => void }>((resolve) =>
        server.listen(0, "127.0.0.1", () =>
          resolve({
            url: `http://up:${encodeURIComponent("p@ss:word")}@127.0.0.1:${(server.address() as net.AddressInfo).port}`,
            seen,
            close: () => {
              server.closeAllConnections();
              server.close();
            },
          }),
        ),
      );
    }

    test("http and CONNECT go through the upstream with its credentials", async () => {
      const up = await startUpstream(site.port);
      const l = await proxy.open({ upstream: up.url });
      const header = basic(l.credentials.username, l.credentials.password);
      const res = await viaProxy(l.server, `http://site.test:${site.port}/chain`, { auth: header });
      expect([res.status, res.body]).toEqual([200, "GET /chain "]);
      const tunnel = await connectTo(l.server, `site.test:${site.port}`, header);
      expect(tunnel.status).toBe(200);
      expect(await throughTunnel(tunnel.socket, "/tunnel", "site.test")).toContain("GET /tunnel");
      expect(up.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
        `GET http://site.test:${site.port}/chain`,
        `CONNECT site.test:${site.port}`,
      ]);
      // The browser's own credentials for this proxy never travel on.
      expect(site.hits[0]?.headers["proxy-authorization"]).toBeUndefined();
      l.close();
      up.close();
    });

    test("private targets are refused here and never reach the upstream", async () => {
      const up = await startUpstream(internal.port);
      const l = await proxy.open({ upstream: up.url });
      const header = basic(l.credentials.username, l.credentials.password);
      expect((await viaProxy(l.server, `http://127.0.0.1:${internal.port}/s`, { auth: header })).status).toBe(403);
      expect((await connectTo(l.server, `127.0.0.1:${internal.port}`, header)).status).toBe(403);
      expect((await connectTo(l.server, `169.254.169.254:80`, header)).status).toBe(403);
      expect(up.seen).toEqual([]);
      expect(internal.hits).toEqual([]);
      l.close();
      up.close();
    });

    test("an upstream that refuses CONNECT is a 502", async () => {
      const up = await startUpstream(site.port);
      const l = await proxy.open({ upstream: up.url.replace("p%40ss%3Aword", "wrong") });
      const res = await connectTo(l.server, `site.test:${site.port}`, basic(l.credentials.username, l.credentials.password));
      expect([res.status, res.headers[EGRESS_HEADER]]).toEqual([502, "upstream"]);
      l.close();
      up.close();
    });
  });

  test("close() stops listening", async () => {
    const server = lease.server;
    lease.close();
    await proxy.close();
    await expect(viaProxy(server, `http://site.test:${site.port}/`)).rejects.toThrow();
  });
});

// The release binary is built with --minify, which renames classes and functions. Nothing may depend on a name (a proxy library
// that told its own errors apart by class name answered 500 to everything once minified).
test("the proxy works from a minified bundle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sex-egress-"));
  const upstream = await startServer();
  try {
    const entry = join(dir, "entry.ts");
    writeFileSync(
      entry,
      `export { EgressProxy } from ${JSON.stringify(join(import.meta.dir, "../src/engine/egress-proxy.ts"))};\n` +
        `export { EgressPolicy } from ${JSON.stringify(join(import.meta.dir, "../../../packages/core/src/egress.ts"))};\n`,
    );
    const built = await Bun.build({ entrypoints: [entry], minify: true, target: "bun" });
    expect(built.success).toBe(true);
    const bundle = join(dir, "bundle.js");
    writeFileSync(bundle, (await built.outputs[0]?.text()) ?? "");
    const { EgressProxy: Minified, EgressPolicy: MinifiedPolicy } = (await import(bundle)) as {
      EgressProxy: typeof EgressProxy;
      EgressPolicy: typeof EgressPolicy;
    };
    const strict = new Minified(new MinifiedPolicy({ allowPrivateNetwork: false }));
    const l = await strict.open();
    const header = basic(l.credentials.username, l.credentials.password);
    expect((await viaProxy(l.server, `http://127.0.0.1:${upstream.port}/`)).status).toBe(407);
    expect((await viaProxy(l.server, `http://127.0.0.1:${upstream.port}/`, { auth: header })).status).toBe(403);
    expect((await connectTo(l.server, `127.0.0.1:${upstream.port}`, header)).status).toBe(403);
    expect(upstream.hits).toEqual([]);
    l.close();
    await strict.close();
    const open = new Minified(new MinifiedPolicy({ allowPrivateNetwork: true }));
    const o = await open.open();
    const ok = await viaProxy(o.server, `http://127.0.0.1:${upstream.port}/fine`, {
      auth: basic(o.credentials.username, o.credentials.password),
    });
    expect([ok.status, ok.body]).toEqual([200, "GET /fine "]);
    o.close();
    await open.close();
  } finally {
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
