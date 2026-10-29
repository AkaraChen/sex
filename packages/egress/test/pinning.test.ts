// DNS pinning: a validated address is connected to directly, with the original host kept in Host / SNI / certificate checks.
import assert from "node:assert/strict";
import { createServer as createHttp, type Server } from "node:http";
import { createServer as createHttps } from "node:https";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { pinToAddress, sendRequest } from "@searxng-js/sex-egress";

// Throwaway self-signed certificate for the DNS name "pinned.test" (test fixture only).
const CERT = `-----BEGIN CERTIFICATE-----
MIIBnDCCAUGgAwIBAgIUOfd8yJlUJ58+Dnc7jEQBl6PLsQQwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLcGlubmVkLnRlc3QwIBcNMjYxMDI1MTQyOTQ3WhgPMjEyNjEw
MDExNDI5NDdaMBYxFDASBgNVBAMMC3Bpbm5lZC50ZXN0MFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEIYdWeHDvvwEXhMtDGuAsofF9h4IT4lcZr8kYgfTEdwUP9K2C
r4Ka74Is7ZoWjFBFbshF4GMRzW7wL9Y2qmV41KNrMGkwHQYDVR0OBBYEFCLT572w
8P2iHMUiV7QNoKOL8eq4MB8GA1UdIwQYMBaAFCLT572w8P2iHMUiV7QNoKOL8eq4
MA8GA1UdEwEB/wQFMAMBAf8wFgYDVR0RBA8wDYILcGlubmVkLnRlc3QwCgYIKoZI
zj0EAwIDSQAwRgIhAMbw+0U1YKkAS3PFakY/0AEpQSJE/nOynxKY1i9woGKWAiEA
+aIn2Hi0LwX5bZ2MeNxBg91NWB6jNgMl3jDm3OgYz6s=
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgRzlDV2FkT2r/eCEp
DGsH6UJghVIx0IN6GH8rZLAyBeGhRANCAAQhh1Z4cO+/AReEy0Ma4Cyh8X2HghPi
VxmvyRiB9MR3BQ/0rYKvgprvgiztmhaMUEVuyEXgYxHNbvAv1jaqZXjU
-----END PRIVATE KEY-----
`;

describe("pinToAddress", () => {
  test("replaces the host with the address and keeps host:port for the Host header", () => {
    const pin = pinToAddress(new URL("http://example.com:8080/a?b=1"), "93.184.216.34");
    assert.equal(pin.url.href, "http://93.184.216.34:8080/a?b=1");
    assert.equal(pin.host, "example.com:8080");
    assert.equal(pin.serverName, undefined);
  });

  test("brackets IPv6 addresses and sets the TLS server name for https", () => {
    const pin = pinToAddress(new URL("https://example.com/x"), "2606:4700::1111");
    assert.equal(pin.url.href, "https://[2606:4700::1111]/x");
    assert.equal(pin.host, "example.com");
    assert.equal(pin.serverName, "example.com");
  });
});

describe("a pinned request reaches the validated address", () => {
  let http: Server;
  let https: Server;
  let httpPort: number;
  let httpsPort: number;

  before(async () => {
    const handler = (req: { headers: { host?: string } }, res: { end(body: string): void }) => res.end(`host=${req.headers.host}`);
    http = createHttp(handler);
    https = createHttps({ cert: CERT, key: KEY }, handler);
    await Promise.all([
      new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => https.listen(0, "127.0.0.1", resolve)),
    ]);
    httpPort = (http.address() as AddressInfo).port;
    httpsPort = (https.address() as AddressInfo).port;
  });
  after(() => {
    http.close();
    https.close();
  });

  const request = (target: string, address: string, ca?: string) => {
    const pin = pinToAddress(new URL(target), address);
    return sendRequest(pin.url, {
      method: "GET",
      body: undefined,
      headers: { host: pin.host },
      signal: AbortSignal.timeout(5000),
      proxy: undefined,
      skipTlsVerification: undefined,
      serverName: pin.serverName,
      ...(ca ? { ca } : {}),
    });
  };

  test("http: connects to the address and sends the original Host", async () => {
    const res = await request(`http://example.test:${httpPort}/`, "127.0.0.1");
    assert.equal(await res.text(), `host=example.test:${httpPort}`);
  });

  test("https: the certificate is checked against the original host name, not the IP", async () => {
    const res = await request(`https://pinned.test:${httpsPort}/`, "127.0.0.1", CERT);
    assert.equal(await res.text(), `host=pinned.test:${httpsPort}`);
    // Same server, but asked for a name the certificate does not cover.
    await assert.rejects(request(`https://other.test:${httpsPort}/`, "127.0.0.1", CERT));
  });
});
