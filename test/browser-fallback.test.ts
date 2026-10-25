import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/core/engine.ts";
import { testEngine } from "./helpers.ts";

// Opt-in: needs a CDP browser, e.g. SEX_TEST_CDP_URL=http://127.0.0.1:9666 bun test test/browser-fallback.test.ts
const CDP = process.env.SEX_TEST_CDP_URL;

// Throwaway self-signed certificate for localhost / 127.0.0.1 (test fixture only).
const CERT = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUcK2B/nZ/V1i/94gceqNkDbfZ0WMwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyNTE0MjEyMloYDzIxMjYxMDAx
MTQyMTIyWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQdLtMTE3HiHuXUFKrJab17zxVxWMOLxOwNs2OFbeTm/yFPpDddITJS
+ZOmK4Mq2cVEIxiP5/U3Egn/EnjnT4F4o28wbTAdBgNVHQ4EFgQUa2l4M/yUi+3y
4sUjQgbqNgniE5MwHwYDVR0jBBgwFoAUa2l4M/yUi+3y4sUjQgbqNgniE5MwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSAAwRQIgHiq/3W41m/lnQsAM3ixZlYIfSfTn/XIvV/s83GYIa5kCIQCR
tUbyO/u9ZV5j9oRx95bDP7s1F+/sK2D6d0rx5Xo6pg==
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgJVB4a/Q2SjNcJ64B
y89h6w4xR6WqdZm2vZadjEz4RrehRANCAAQdLtMTE3HiHuXUFKrJab17zxVxWMOL
xOwNs2OFbeTm/yFPpDddITJS+ZOmK4Mq2cVEIxiP5/U3Egn/EnjnT4F4
-----END PRIVATE KEY-----
`;

const page = `<!doctype html><html lang="en"><head><title>Secure Fixture</title></head><body><main><article><h1>Secure heading</h1><p>Served over self-signed TLS.</p></article></main></body></html>`;

describe.skipIf(!CDP)("browser fallbacks", () => {
  let http: ReturnType<typeof Bun.serve>;
  let https: ReturnType<typeof Bun.serve>;
  let engine: Engine;
  const origin = () => `http://127.0.0.1:${http.port}`;

  beforeAll(() => {
    http = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/doc.pdf") return new Response("%PDF-1.4\nnot a real pdf", { headers: { "content-type": "application/pdf" } });
        if (pathname === "/download") {
          return new Response("<html><body>attached</body></html>", {
            headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="a.bin"' },
          });
        }
        if (pathname === "/download.txt") {
          return new Response("plain attached text", {
            headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="a.txt"' },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    https = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { cert: CERT, key: KEY },
      fetch: () => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    engine = testEngine({ cdpUrl: CDP });
  });

  afterAll(async () => {
    await engine?.browser.close();
    http?.stop(true);
    https?.stop(true);
  });

  test("a PDF falls back to the plain-HTTP path instead of failing with net::ERR_ABORTED", async () => {
    // The PDF bytes are bogus, so reaching the PDF parser (422) proves the fallback happened.
    const err = await engine.scrape({ url: `${origin()}/doc.pdf` }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("PDF_PARSE_FAILED");
  });

  test("a Content-Disposition: attachment text file falls back to the plain-HTTP path", async () => {
    const doc = await engine.scrape({ url: `${origin()}/download.txt`, formats: ["markdown"] });
    expect(doc.markdown).toContain("plain attached text");
  });

  test("skipTlsVerification is honored in the browser", async () => {
    const url = `https://127.0.0.1:${https.port}/`;
    const strict = await engine.scrape({ url }).catch((e: unknown) => e);
    expect((strict as { code?: string }).code).toBe("FETCH_FAILED");
    const doc = await engine.scrape({ url, skipTlsVerification: true, formats: ["markdown"] });
    expect(doc.markdown).toContain("Served over self-signed TLS");
  });
});
