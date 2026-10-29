// Stored crawl headers are redacted in the active listing, and responses carry request ids.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { JobRecord } from "@searxng-js/sex-jobs";
import type { Engine } from "../src/engine/engine.ts";
import { createApp } from "../src/http/server.ts";
import { testEngine } from "./helpers.ts";

describe("observability", () => {
  let site: ReturnType<typeof Bun.serve>;
  let engine: Engine;
  let job: JobRecord | undefined;

  beforeAll(() => {
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response("<!doctype html><html><head><title>Home</title></head><body><main><p>Home page.</p></main></body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });
    engine = testEngine();
  });

  afterAll(async () => {
    if (job) await engine.cancelJob(job).catch(() => {});
    site.stop(true);
  });

  test("GET /v2/crawl/active redacts stored header values", async () => {
    job = await engine.crawl({
      url: `http://127.0.0.1:${site.port}/`,
      delay: 5,
      scrapeOptions: { headers: { cookie: "secret-cookie" } },
      webhook: { url: "http://127.0.0.1:1/hook", headers: { authorization: "Bearer t" } },
    });

    const { app } = createApp(engine);
    const res = await app.request("/v2/crawl/active");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("secret-cookie");
    expect(text).not.toContain("Bearer t");
    expect(text).toContain("[redacted]");
    expect(text).toContain(job.id);
  });

  test("responses carry an x-request-id, echoing a valid incoming one", async () => {
    const { app } = createApp(engine);

    const generated = await app.request(`/v2/crawl/${crypto.randomUUID()}`);
    expect(generated.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);

    const echoed = await app.request(`/v2/crawl/${crypto.randomUUID()}`, { headers: { "x-request-id": "abc-123" } });
    expect(echoed.headers.get("x-request-id")).toBe("abc-123");

    const rejected = await app.request(`/v2/crawl/${crypto.randomUUID()}`, { headers: { "x-request-id": "bad id with spaces" } });
    expect(rejected.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});
