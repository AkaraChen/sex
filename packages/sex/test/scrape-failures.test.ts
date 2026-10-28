import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import type { AppError } from "@sex/core/errors.ts";
import type { Engine } from "../src/engine/engine.ts";
import { createApp } from "../src/http/server.ts";
import { CERT, chatCompletionStream, KEY, startFixtureSite, startMockSearxng, testEngine } from "./helpers.ts";

const servers: Array<{ stop: (force?: boolean) => void }> = [];
const sockets: Server[] = [];
let engine: Engine;
let site: ReturnType<typeof startFixtureSite>;
let tls: ReturnType<typeof Bun.serve>;
let slow: ReturnType<typeof Bun.serve>;
let resetUrl: string;

beforeAll(async () => {
  engine = testEngine();
  site = startFixtureSite();
  tls = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: CERT, key: KEY },
    fetch: () =>
      new Response("<html><body><main><article><h1>Secure</h1><p>Served over TLS.</p></article></main></body></html>", {
        headers: { "content-type": "text/html" },
      }),
  });
  // Sends the headers at once and the body never: only a deadline gets a scrape out of this.
  slow = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(new ReadableStream({ start: (c) => void c.enqueue(new TextEncoder().encode("<html><body>")) }), {
        headers: { "content-type": "text/html" },
      }),
  });
  servers.push(tls, slow);
  const reset = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => reset.listen(0, "127.0.0.1", resolve));
  sockets.push(reset);
  resetUrl = `http://127.0.0.1:${(reset.address() as { port: number }).port}/`;
});

afterAll(async () => {
  await engine.close();
  site.stop();
  for (const s of servers) s.stop(true);
  for (const s of sockets) s.close();
});

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    return err as AppError;
  }
  throw new Error("expected rejection");
}

describe("deterministic page failures are not 502", () => {
  test("an unknown host is a 500 SCRAPE_DNS_RESOLUTION_ERROR that is not worth retrying", async () => {
    const err = await rejection(engine.scrape({ url: "http://no-such-host.invalid/" }));
    expect(err).toMatchObject({ status: 500, code: "SCRAPE_DNS_RESOLUTION_ERROR", retryable: false });
    expect(err.message).toContain("no-such-host.invalid");
  });

  test("a refused connection is a 500 SCRAPE_SITE_ERROR", async () => {
    const err = await rejection(engine.scrape({ url: "http://127.0.0.1:1/" }));
    expect(err).toMatchObject({ status: 500, code: "SCRAPE_SITE_ERROR" });
  });

  test("a connection that is reset is a 500 SCRAPE_SITE_ERROR", async () => {
    const err = await rejection(engine.scrape({ url: resetUrl }));
    expect(err).toMatchObject({ status: 500, code: "SCRAPE_SITE_ERROR" });
  });

  test("an untrusted certificate is a 500 SCRAPE_SSL_ERROR naming skipTlsVerification, and skipTlsVerification fixes it", async () => {
    const url = `https://127.0.0.1:${tls.port}/`;
    const err = await rejection(engine.scrape({ url }));
    expect(err).toMatchObject({ status: 500, code: "SCRAPE_SSL_ERROR" });
    expect(err.message).toContain("skipTlsVerification");
    const doc = await engine.scrape({ url, skipTlsVerification: true, formats: ["markdown"] });
    expect(doc.markdown).toContain("Served over TLS");
  });

  test("the HTTP API answers with the status, the code and whether a retry can help", async () => {
    const { app } = createApp(engine);
    const post = async (url: string) => {
      const res = await app.fetch(
        new Request("http://sex.test/v2/scrape", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        }),
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const dns = await post("http://no-such-host.invalid/");
    expect(dns.status).toBe(500);
    expect(dns.body).toMatchObject({ success: false, code: "SCRAPE_DNS_RESOLUTION_ERROR", retryable: false });
    const refused = await post("http://127.0.0.1:1/");
    expect(refused.status).toBe(500);
    expect(refused.body).toMatchObject({ success: false, code: "SCRAPE_SITE_ERROR", retryable: true });
  });
});

describe("one deadline for the whole scrape", () => {
  test("a body that never ends is cut off at `timeout` as SCRAPE_TIMEOUT", async () => {
    const t0 = performance.now();
    const err = await rejection(engine.scrape({ url: `http://127.0.0.1:${slow.port}/`, timeout: 1000 }));
    const took = performance.now() - t0;
    expect(err).toMatchObject({ status: 408, code: "SCRAPE_TIMEOUT" });
    expect(took).toBeGreaterThan(900);
    expect(took).toBeLessThan(2500);
  });

  test("a cancelled caller is TIMEOUT and stops the scrape at once", async () => {
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 150);
    const t0 = performance.now();
    const err = await rejection(engine.scrape({ url: `http://127.0.0.1:${slow.port}/`, timeout: 30_000 }, caller.signal));
    expect(err).toMatchObject({ status: 408, code: "TIMEOUT" });
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  test("inside a search the scrape's own timeout is still SCRAPE_TIMEOUT, in the page's metadata.error", async () => {
    const searx = startMockSearxng(`http://127.0.0.1:${slow.port}`);
    servers.push({ stop: searx.stop });
    const searching = testEngine({ searxngUrl: searx.url });
    try {
      const { data } = await searching.search({ query: "x", limit: 1, scrapeOptions: { formats: ["markdown"], timeout: 1000 } });
      expect(data.web?.[0]?.metadata).toMatchObject({ statusCode: 408 });
      expect(data.web?.[0]?.metadata?.error).toContain("Timed out after 1000ms");
    } finally {
      await searching.close();
    }
  }, 15_000);

  test("a scrape that is already cancelled does not start", async () => {
    const err = await rejection(engine.scrape({ url: `${site.url}/docs/a` }, AbortSignal.abort()));
    expect(err).toMatchObject({ status: 408, code: "TIMEOUT" });
    expect(err.message).toContain("before the scrape started");
  });

  test("the LLM formats are part of `timeout`: a slow LLM ends the scrape with SCRAPE_TIMEOUT", async () => {
    const llm = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch() {
        await Bun.sleep(1500);
        return chatCompletionStream("A summary.");
      },
    });
    servers.push(llm);
    const withLlm = testEngine({ llmModel: "m", llmBaseUrl: `http://127.0.0.1:${llm.port}/v1`, llmTimeout: 10_000 });
    try {
      const err = await rejection(withLlm.scrape({ url: `${site.url}/docs/a`, formats: ["markdown", "summary"], timeout: 1000 }));
      expect(err).toMatchObject({ status: 408, code: "SCRAPE_TIMEOUT" });
      // With room for the LLM, the same request succeeds.
      const doc = await withLlm.scrape({ url: `${site.url}/docs/a`, formats: ["markdown", "summary"], timeout: 5000 });
      expect(doc.summary).toBe("A summary.");
      expect(doc.warning).toBeUndefined();
    } finally {
      await withLlm.close();
    }
  });
});
