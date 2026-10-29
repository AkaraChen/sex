import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { AdBlockList, EGRESS_HEADER, type EgressLease, EgressProxy } from "@searxng-js/sex-browser";
import { EgressPolicy } from "@searxng-js/sex-egress";
import { basic, connectTo, startServer, throughTunnel, viaProxy } from "./proxy-support.ts";

// No browser needed: requests are made straight at the proxy, the way a browser would make them.

/** A policy that, for names a test declares, answers what `EgressPolicy` would after validating a public address. */
class FakePublicNames extends EgressPolicy {
  readonly names: Record<string, string[]>;
  constructor(names: Record<string, string[]>, opts: ConstructorParameters<typeof EgressPolicy>[0] = { allowPrivateNetwork: false }) {
    super(opts);
    this.names = names;
  }
  override async resolve(url: Pick<URL, "hostname" | "href">, requireResolvable = false) {
    return this.names[url.hostname] ?? super.resolve(url, requireResolvable);
  }
}

describe("EgressProxy", () => {
  let site: Awaited<ReturnType<typeof startServer>>;
  let internal: Awaited<ReturnType<typeof startServer>>;
  let proxy: EgressProxy;
  let lease: EgressLease;
  const auth = () => basic(lease.credentials.username, lease.credentials.password);
  const names = () => ({ "site.test": ["127.0.0.1"] });

  before(async () => {
    site = await startServer();
    internal = await startServer();
  });
  after(() => {
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
      assert.equal(res.status, 407);
      assert.match(res.headers["proxy-authenticate"] ?? "", /Basic/);
      assert.equal((await connectTo(lease.server, `site.test:${site.port}`)).status, 407);
      assert.deepEqual(site.hits, []);
    });

    test("wrong password, wrong user and a different scheme are 407", async () => {
      const target = `http://site.test:${site.port}/x`;
      for (const header of [
        basic(lease.credentials.username, "nope"),
        basic("nope", lease.credentials.password),
        `Bearer ${lease.credentials.password}`,
        "Basic !!!",
      ]) {
        assert.equal((await viaProxy(lease.server, target, { auth: header })).status, 407);
        assert.equal((await connectTo(lease.server, `site.test:${site.port}`, header)).status, 407);
      }
      assert.deepEqual(site.hits, []);
    });

    test("the right credentials work, for http and for CONNECT", async () => {
      const res = await viaProxy(lease.server, `http://site.test:${site.port}/x`, { auth: auth() });
      assert.deepEqual([res.status, res.body], [200, "GET /x "]);
      const tunnel = await connectTo(lease.server, `site.test:${site.port}`, auth());
      assert.equal(tunnel.status, 200);
      assert.ok((await throughTunnel(tunnel.socket, "/t", `site.test:${site.port}`)).includes("GET /t"));
    });

    test("credentials of another lease do not work, and a closed lease's stop working", async () => {
      const other = await proxy.open();
      assert.equal(
        (
          await viaProxy(lease.server, `http://site.test:${site.port}/x`, {
            auth: basic(other.credentials.username, lease.credentials.password),
          })
        ).status,
        407,
      );
      const stale = auth();
      lease.close();
      assert.equal((await viaProxy(lease.server, `http://site.test:${site.port}/x`, { auth: stale })).status, 407);
      assert.equal((await connectTo(lease.server, `site.test:${site.port}`, stale)).status, 407);
      assert.deepEqual(site.hits, []);
      other.close();
    });

    test("ending a lease closes its open tunnels, not another lease's", async () => {
      const other = await proxy.open();
      const mine = await connectTo(lease.server, `site.test:${site.port}`, auth());
      const theirs = await connectTo(other.server, `site.test:${site.port}`, basic(other.credentials.username, other.credentials.password));
      const closed = new Promise<void>((resolve) => mine.socket.once("close", () => resolve()));
      lease.close();
      await closed;
      assert.equal(theirs.socket.destroyed, false);
      theirs.socket.destroy();
      other.close();
    });

    test("a request that is not a proxy request (origin-form) is refused after authentication", async () => {
      const res = await viaProxy(lease.server, "/just-a-path", { auth: auth() });
      assert.equal(res.status, 400);
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
        assert.deepEqual([authority, res.status, res.headers[EGRESS_HEADER]], [authority, 403, "refused"]);
      }
      assert.deepEqual(internal.hits, []);
    });

    test("CONNECT: refused with 403 and the internal service receives nothing", async () => {
      for (const authority of targets()) {
        const res = await connectTo(lease.server, authority, auth());
        assert.deepEqual([authority, res.status, res.headers[EGRESS_HEADER]], [authority, 403, "refused"]);
        res.socket.destroy();
      }
      assert.deepEqual(internal.hits, []);
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
        assert.equal((await viaProxy(l.server, `http://${host}:${internal.port}/`, { auth: header })).status, 403);
        assert.equal((await connectTo(l.server, `${host}:${internal.port}`, header)).status, 403);
      }
      assert.deepEqual(internal.hits, []);
      assert.equal(l.failureOf("internal.test"), "refused");
      l.close();
      await strict.close();
    });

    test("with private networks allowed nothing is refused", async () => {
      const open = new EgressProxy(new EgressPolicy({ allowPrivateNetwork: true }));
      const l = await open.open();
      const res = await viaProxy(l.server, `http://127.0.0.1:${internal.port}/ok`, {
        auth: basic(l.credentials.username, l.credentials.password),
      });
      assert.deepEqual([res.status, res.body], [200, "GET /ok "]);
      l.close();
      await open.close();
    });

    test("a name that does not resolve is a 502 the lease remembers", async () => {
      const policy = new EgressPolicy({ allowPrivateNetwork: false, resolver: async () => [] });
      const p = new EgressProxy(policy);
      const l = await p.open({ upstream: "http://127.0.0.1:9" }); // an upstream makes resolving here mandatory
      const res = await viaProxy(l.server, "http://nowhere.test/", { auth: basic(l.credentials.username, l.credentials.password) });
      assert.deepEqual([res.status, res.headers[EGRESS_HEADER]], [502, "dns"]);
      assert.equal(l.failureOf("nowhere.test"), "dns");
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
      assert.deepEqual([res.status, res.body], [200, "GET /p "]);
      assert.equal(site.hits[0]?.headers.host, `pinned.test:${site.port}`);
      const tunnel = await connectTo(l.server, `pinned.test:${site.port}`, header);
      assert.equal(tunnel.status, 200);
      assert.ok((await throughTunnel(tunnel.socket, "/t", "pinned.test")).includes("GET /t"));
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
      assert.equal((await viaProxy(l.server, `http://multi.test:${site.port}/m`, { auth: header })).body, "GET /m ");
      assert.equal((await connectTo(l.server, `multi.test:${site.port}`, header)).status, 200);
      assert.equal((await viaProxy(l.server, `http://multi.test:${deadPort}/m`, { auth: header })).status, 502);
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
      assert.equal(headers["x-keep"], "yes");
      assert.equal(headers["accept-language"], "de");
      assert.equal(headers.host, `site.test:${site.port}`);
      for (const name of ["proxy-authorization", "proxy-connection", "x-drop", "keep-alive", "te", "upgrade"]) {
        assert.deepEqual([name, headers[name]], [name, undefined]);
      }
    });

    test("response hop-by-hop headers are dropped, repeated headers survive", async () => {
      const res = await viaProxy(lease.server, `http://site.test:${site.port}/cookies`, { auth: auth() });
      assert.deepEqual(res.rawSetCookie, ["a=1", "b=2"]);
      assert.equal(res.headers["x-hop"], undefined);
    });

    test("a redirect is passed on as it is, not followed", async () => {
      const res = await viaProxy(lease.server, `http://site.test:${site.port}/redirect`, { auth: auth() });
      assert.equal(res.status, 302);
      assert.match(res.headers.location ?? "", /^http:\/\/127\.0\.0\.1:/);
      assert.deepEqual(
        site.hits.map((h) => h.url),
        ["/redirect"],
      );
    });

    test("the redirect's target is checked when the browser follows it", async () => {
      const res = await viaProxy(lease.server, `http://127.0.0.1:${internal.port}/elsewhere`, { auth: auth() });
      assert.equal(res.status, 403);
      assert.deepEqual(internal.hits, []);
    });

    test("a request body arrives intact", async () => {
      const res = await viaProxy(lease.server, `http://site.test:${site.port}/post`, {
        auth: auth(),
        method: "POST",
        body: "payload",
        headers: { "content-length": "7" },
      });
      assert.equal(res.body, "POST /post payload");
    });

    test("an unreachable origin is a 502 with the proxy's marker", async () => {
      const gone = await startServer();
      const port = gone.port;
      gone.close();
      const res = await viaProxy(lease.server, `http://site.test:${port}/`, { auth: auth() });
      assert.deepEqual([res.status, res.headers[EGRESS_HEADER]], [502, "upstream"]);
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
      assert.equal(await got, "echo:hello");
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
      assert.equal((await connectTo(lease.server, "no-port", auth())).status, 400);
      assert.equal((await connectTo(lease.server, "site.test:99999", auth())).status, 400);
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
      assert.deepEqual([res.status, res.headers[EGRESS_HEADER]], [403, "ad"]);
      assert.equal((await connectTo(l.server, "sub.tracker.test:443", header)).status, 403);
      assert.equal(l.adsBlocked(), 2);
      // An exception rule wins, and the page's own host is never refused.
      assert.equal((await viaProxy(l.server, `http://ok.tracker.test:${site.port}/ok`, { auth: header })).status, 200);
      assert.deepEqual(
        site.hits.map((h) => h.url),
        ["/ok"],
      );
      // A third-party-only rule does not apply to the page's own site.
      assert.equal((await viaProxy(l.server, `http://page.test:${site.port}/`, { auth: header })).status, 200);
      l.close();
      await p.close();
    });

    test("a page on a listed domain can still be scraped", async () => {
      const p = new EgressProxy(new FakePublicNames({ "tracker.test": ["127.0.0.1"] }));
      const l = await p.open({ adBlock: { list, pageUrl: `http://tracker.test:${site.port}/` } });
      const res = await viaProxy(l.server, `http://tracker.test:${site.port}/page`, {
        auth: basic(l.credentials.username, l.credentials.password),
      });
      assert.equal(res.status, 200);
      l.close();
      await p.close();
    });

    test("without a list nothing is refused for being an ad", async () => {
      const res = await viaProxy(lease.server, `http://site.test:${site.port}/x`, { auth: auth() });
      assert.equal(res.status, 200);
      assert.equal(lease.adsBlocked(), 0);
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
      assert.deepEqual([res.status, res.body], [200, "GET /chain "]);
      const tunnel = await connectTo(l.server, `site.test:${site.port}`, header);
      assert.equal(tunnel.status, 200);
      assert.ok((await throughTunnel(tunnel.socket, "/tunnel", "site.test")).includes("GET /tunnel"));
      assert.deepEqual(
        up.seen.map((s) => `${s.method} ${s.url}`),
        [`GET http://site.test:${site.port}/chain`, `CONNECT site.test:${site.port}`],
      );
      // The browser's own credentials for this proxy never travel on.
      assert.equal(site.hits[0]?.headers["proxy-authorization"], undefined);
      l.close();
      up.close();
    });

    test("private targets are refused here and never reach the upstream", async () => {
      const up = await startUpstream(internal.port);
      const l = await proxy.open({ upstream: up.url });
      const header = basic(l.credentials.username, l.credentials.password);
      assert.equal((await viaProxy(l.server, `http://127.0.0.1:${internal.port}/s`, { auth: header })).status, 403);
      assert.equal((await connectTo(l.server, `127.0.0.1:${internal.port}`, header)).status, 403);
      assert.equal((await connectTo(l.server, `169.254.169.254:80`, header)).status, 403);
      assert.deepEqual(up.seen, []);
      assert.deepEqual(internal.hits, []);
      l.close();
      up.close();
    });

    test("an upstream that refuses CONNECT is a 502", async () => {
      const up = await startUpstream(site.port);
      const l = await proxy.open({ upstream: up.url.replace("p%40ss%3Aword", "wrong") });
      const res = await connectTo(l.server, `site.test:${site.port}`, basic(l.credentials.username, l.credentials.password));
      assert.deepEqual([res.status, res.headers[EGRESS_HEADER]], [502, "upstream"]);
      l.close();
      up.close();
    });
  });

  test("close() stops listening", async () => {
    const server = lease.server;
    lease.close();
    await proxy.close();
    await assert.rejects(viaProxy(server, `http://site.test:${site.port}/`));
  });
});
