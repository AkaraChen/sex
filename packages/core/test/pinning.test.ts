// DNS pinning: a validated address is connected to directly, with the original host kept in Host / SNI / certificate checks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pinToAddress } from "../src/net.ts";

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
    expect(pin.url.href).toBe("http://93.184.216.34:8080/a?b=1");
    expect(pin.host).toBe("example.com:8080");
    expect(pin.serverName).toBeUndefined();
  });

  test("brackets IPv6 addresses and sets the TLS server name for https", () => {
    const pin = pinToAddress(new URL("https://example.com/x"), "2606:4700::1111");
    expect(pin.url.href).toBe("https://[2606:4700::1111]/x");
    expect(pin.host).toBe("example.com");
    expect(pin.serverName).toBe("example.com");
  });
});

describe("a pinned request reaches the validated address", () => {
  let http: ReturnType<typeof Bun.serve>;
  let https: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(`host=${req.headers.get("host")}`) });
    https = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { cert: CERT, key: KEY },
      fetch: (req) => new Response(`host=${req.headers.get("host")}`),
    });
  });
  afterAll(() => {
    http.stop(true);
    https.stop(true);
  });

  const request = (target: string, address: string, tls?: Record<string, unknown>) => {
    const pin = pinToAddress(new URL(target), address);
    return fetch(pin.url, {
      headers: { host: pin.host },
      tls: { ...(pin.serverName ? { serverName: pin.serverName } : {}), ...tls },
    } as RequestInit);
  };

  test("http: connects to the address and sends the original Host", async () => {
    const res = await request(`http://example.test:${http.port}/`, "127.0.0.1");
    expect(await res.text()).toBe(`host=example.test:${http.port}`);
  });

  test("https: the certificate is checked against the original host name, not the IP", async () => {
    const res = await request(`https://pinned.test:${https.port}/`, "127.0.0.1", { ca: CERT });
    expect(await res.text()).toBe(`host=pinned.test:${https.port}`);
    // Same server, but asked for a name the certificate does not cover.
    await expect(request(`https://other.test:${https.port}/`, "127.0.0.1", { ca: CERT })).rejects.toThrow();
  });
});
