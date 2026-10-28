import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/engine/engine.ts";
import { createApp } from "../src/http/server.ts";
import { testEngine } from "./helpers.ts";

let engine: Engine;

beforeAll(() => {
  engine = testEngine();
});

afterAll(async () => {
  await engine.close();
});

const post = async (path: string, body: unknown) => {
  const { app } = createApp(engine);
  const res = await app.fetch(
    new Request(`http://sex.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("request limits", () => {
  test("waitFor above 60000 is rejected", async () => {
    const { status, body } = await post("/v2/scrape", { url: "http://127.0.0.1:1/", waitFor: 600000 });
    expect(status).toBe(400);
    expect(body).toMatchObject({ success: false, code: "BAD_REQUEST" });
    expect(body.error).toContain("waitFor");
  });

  test("timeout outside 1000-300000 is rejected", async () => {
    const low = await post("/v2/scrape", { url: "http://127.0.0.1:1/", timeout: 10 });
    expect(low.status).toBe(400);
    expect(low.body.code).toBe("BAD_REQUEST");

    const high = await post("/v2/scrape", { url: "http://127.0.0.1:1/", timeout: 300001 });
    expect(high.status).toBe(400);
    expect(high.body.code).toBe("BAD_REQUEST");
  });

  test("wait action above 60000 milliseconds is rejected", async () => {
    const { status, body } = await post("/v2/scrape", {
      url: "http://127.0.0.1:1/",
      actions: [{ type: "wait", milliseconds: 3600000 }],
    });
    expect(status).toBe(400);
    expect(body.code).toBe("BAD_REQUEST");
  });

  test("waitFor plus all wait actions above 60000 is rejected, at 60000 it passes", async () => {
    const url = "http://127.0.0.1:1/";
    const over = await post("/v2/scrape", {
      url,
      waitFor: 30000,
      actions: [
        { type: "wait", milliseconds: 20000 },
        { type: "wait", milliseconds: 10001 },
      ],
    });
    expect(over.status).toBe(400);
    expect(over.body.code).toBe("BAD_REQUEST");
    expect(over.body.error).toContain("waitFor");

    const exact = await post("/v2/scrape", {
      url,
      waitFor: 30000,
      actions: [
        { type: "wait", milliseconds: 20000 },
        { type: "wait", milliseconds: 10000 },
      ],
    });
    expect(exact.body.code).not.toBe("BAD_REQUEST");
  });

  test("a wait that is by selector adds nothing to the total", async () => {
    const { body } = await post("/v2/scrape", {
      url: "http://127.0.0.1:1/",
      waitFor: 60000,
      actions: [{ type: "wait", selector: "#ready" }],
    });
    expect(body.code).not.toBe("BAD_REQUEST");
  });

  test("the same limit applies to scrapeOptions of search and batch", async () => {
    const scrapeOptions = { waitFor: 60000, actions: [{ type: "wait", milliseconds: 1 }] };
    expect((await post("/v2/search", { query: "q", scrapeOptions })).status).toBe(400);
    expect((await post("/v2/batch/scrape", { urls: ["http://127.0.0.1:1/"], ...scrapeOptions })).status).toBe(400);
  });

  test("a wait action needs exactly one of milliseconds and selector", async () => {
    for (const action of [{ type: "wait" }, { type: "wait", milliseconds: 100, selector: "#a" }]) {
      const { status, body } = await post("/v2/scrape", { url: "http://127.0.0.1:1/", actions: [action] });
      expect(status).toBe(400);
      expect(body.code).toBe("BAD_REQUEST");
      expect(body.error).toContain("milliseconds");
    }
  });

  test("more than 50 includeDomains is rejected", async () => {
    const includeDomains = Array.from({ length: 51 }, (_, i) => `site${i}.example`);
    const { status, body } = await post("/v2/search", { query: "q", includeDomains });
    expect(status).toBe(400);
    expect(body.code).toBe("BAD_REQUEST");
  });

  test("crawl limit above 100000 is rejected", async () => {
    const { status, body } = await post("/v2/crawl", { url: "http://127.0.0.1:1/", limit: 100001 });
    expect(status).toBe(400);
    expect(body.code).toBe("BAD_REQUEST");
  });

  test("values at the bounds pass validation", async () => {
    // Validation passes, so the request fails later (connection refused), never with BAD_REQUEST.
    const { status, body } = await post("/v2/scrape", { url: "http://127.0.0.1:1/", waitFor: 60000, timeout: 300000 });
    expect(status).not.toBe(400);
    expect(body.code).not.toBe("BAD_REQUEST");
  });
});

describe("search fan-out cap", () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(50);
      inFlight--;
      return Response.json({ results: [] });
    },
  });
  afterAll(() => server.stop(true));

  test("per-domain SearXNG queries run at most 4 at a time", async () => {
    const searchEngine = testEngine({ searxngUrl: `http://127.0.0.1:${server.port}` });
    try {
      const includeDomains = Array.from({ length: 20 }, (_, i) => `site${i}.example`);
      const result = await searchEngine.search({ query: "q", includeDomains });
      expect(result.data).toBeDefined();
      expect(maxInFlight).toBeLessThanOrEqual(4);
      expect(maxInFlight).toBeGreaterThan(1);
    } finally {
      await searchEngine.close();
    }
  });
});
