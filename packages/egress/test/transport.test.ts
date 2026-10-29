// The transport under safeFetch (undici on Node, fetch on Bun): TLS options, content decoding, proxy, private hosts, no leaked sockets.
import assert from "node:assert/strict";
import { createServer as createHttp, type Server } from "node:http";
import { createServer as createHttps } from "node:https";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { gzipSync } from "node:zlib";
import { safeFetch } from "@searxng-js/sex-egress";
import { CERT, KEY, startCountingProxy } from "@searxng-js/sex-testing";

const options = (extra: Record<string, unknown> = {}) => ({
  signal: AbortSignal.timeout(5000),
  allowPrivateNetwork: true,
  proxy: undefined,
  userAgent: "t",
  ...extra,
});
const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e as { code?: string },
  );

describe("safeFetch transport", () => {
  let http: Server;
  let httpPort: number;
  let connections = 0;
  const seen: Array<Record<string, string | string[] | undefined>> = [];

  before(async () => {
    http = createHttp((req, res) => {
      seen.push(req.headers);
      if (req.url === "/gzip") {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        res.end(gzipSync("zipped body"));
        return;
      }
      res.end(`host=${req.headers.host}`);
    });
    http.on("connection", () => connections++);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    httpPort = (http.address() as AddressInfo).port;
  });
  after(() => {
    http.closeAllConnections();
    http.close();
  });

  test("a caller-set Accept-Encoding: gzip still gives a decoded body", async () => {
    const res = await safeFetch(`http://127.0.0.1:${httpPort}/gzip`, options({ headers: { "Accept-Encoding": "gzip" } }));
    assert.equal(new TextDecoder().decode(res.body), "zipped body");
  });

  test("a host that is private by name is refused before any connection", async () => {
    const before = connections;
    for (const host of ["localhost", "app.localhost"]) {
      const err = await caught(safeFetch(`http://${host}:${httpPort}/`, options({ allowPrivateNetwork: false })));
      assert.equal(err?.code, "PRIVATE_NETWORK_BLOCKED");
    }
    assert.equal(connections, before);
  });

  test("a refused connection is named SCRAPE_SITE_ERROR (undici puts the code on the cause)", async () => {
    const closed = createHttp();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    assert.equal((await caught(safeFetch(`http://127.0.0.1:${port}/`, options())))?.code, "SCRAPE_SITE_ERROR");
  });

  describe("https with a self-signed certificate", () => {
    let https: Server;
    let port: number;
    before(async () => {
      https = createHttps({ cert: CERT, key: KEY }, (_req, res) => res.end("secure"));
      await new Promise<void>((resolve) => https.listen(0, "127.0.0.1", resolve));
      port = (https.address() as AddressInfo).port;
    });
    after(() => {
      https.closeAllConnections();
      https.close();
    });

    test("is rejected as SCRAPE_SSL_ERROR, and fetched with skipTlsVerification", async () => {
      assert.equal((await caught(safeFetch(`https://127.0.0.1:${port}/`, options())))?.code, "SCRAPE_SSL_ERROR");
      const res = await safeFetch(`https://127.0.0.1:${port}/`, options({ skipTlsVerification: true }));
      assert.equal(new TextDecoder().decode(res.body), "secure");
    });
  });

  describe("through a proxy", () => {
    test("is not pinned, uses the proxy URL's credentials and drops the caller's proxy headers", async () => {
      // 93.184.216.34 is a public literal: it passes the SSRF check without DNS and the proxy delivers it to the local server.
      const proxy = await startCountingProxy(() => new URL(`http://127.0.0.1:${httpPort}/`), { auth: "user:secret" });
      try {
        const res = await safeFetch(
          "http://93.184.216.34/",
          options({
            allowPrivateNetwork: false,
            proxy: proxy.url.replace("http://", "http://user:secret@"),
            headers: { "Proxy-Authorization": "Basic Y2FsbGVyOmV2aWw=", "Proxy-Connection": "close" },
          }),
        );
        assert.equal(res.status, 200);
        assert.equal(proxy.requests.length, 1);
        const headers = proxy.requests[0]?.headers as Headers;
        assert.equal(headers.get("proxy-authorization"), `Basic ${btoa("user:secret")}`);
        assert.notEqual(headers.get("proxy-connection"), "close");
        assert.equal(proxy.connects.length, 0);
      } finally {
        proxy.close();
      }
    });

    test("a name that does not resolve locally is refused, with no request to the proxy", async () => {
      const proxy = await startCountingProxy();
      try {
        const err = await caught(safeFetch("http://does-not-exist.invalid/", options({ allowPrivateNetwork: false, proxy: proxy.url })));
        assert.ok(err?.code);
        assert.equal(proxy.requests.length, 0);
      } finally {
        proxy.close();
      }
    });
  });
});
