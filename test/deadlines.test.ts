import { afterAll, describe, expect, test } from "bun:test";
import { normalizeFormats, scrapeTimeout } from "../src/core/scrape.ts";
import { AppError } from "../src/errors.ts";
import { startFixtureSite, testEngine } from "./helpers.ts";

const hanging = () => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });

const servers: Array<{ stop: (force?: boolean) => void }> = [];
const site = startFixtureSite();
servers.push(site);
afterAll(() => {
  for (const s of servers) s.stop(true);
});

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected rejection");
}

describe("outbound deadlines", () => {
  test("a hanging SearXNG is reported as 408 TIMEOUT", async () => {
    const searx = hanging();
    servers.push(searx);
    const engine = testEngine({ searxngUrl: `http://127.0.0.1:${searx.port}`, timeout: 300 });
    const started = Date.now();
    const err = await rejection(engine.search({ query: "x" }, new AbortController().signal));
    expect(Date.now() - started).toBeLessThan(2000);
    expect({ status: err.status, code: err.code }).toEqual({ status: 408, code: "TIMEOUT" });
  });

  test("a non-JSON SearXNG response is reported as SEARCH_BACKEND_ERROR", async () => {
    const searx = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("<html>nope</html>", { headers: { "content-type": "text/html" } }),
    });
    servers.push(searx);
    const engine = testEngine({ searxngUrl: `http://127.0.0.1:${searx.port}` });
    const err = await rejection(engine.search({ query: "x" }));
    expect(err.code).toBe("SEARCH_BACKEND_ERROR");
    expect(err.message).toContain("text/html");
  });

  test("a hanging LLM is reported as TIMEOUT", async () => {
    const llm = hanging();
    servers.push(llm);
    const engine = testEngine({ llmModel: "m", llmBaseUrl: `http://127.0.0.1:${llm.port}/v1`, llmTimeout: 1000 });
    const started = Date.now();
    const doc = await engine.scrape({ url: `${site.url}/docs/a`, formats: ["markdown", "summary"] });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(doc.summary).toBeUndefined();
    expect(doc.markdown).toContain("Doc A");
    expect(doc.warning).toContain("Summary failed");
  }, 10_000);

  test("LLM time counts toward the scrape's timeout", async () => {
    const llm = hanging();
    servers.push(llm);
    // SEX_LLM_TIMEOUT alone would allow 2 minutes; the request's timeout ends the scrape first.
    const engine = testEngine({ llmModel: "m", llmBaseUrl: `http://127.0.0.1:${llm.port}/v1`, llmTimeout: 120_000 });
    const started = Date.now();
    const err = await rejection(engine.scrape({ url: `${site.url}/docs/a`, formats: ["summary"], timeout: 1500 }));
    expect(err).toMatchObject({ status: 408, code: "SCRAPE_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(4000);
    const guarded = await rejection(engine.scrape({ url: `${site.url}/docs/a`, checkPromptInjection: true, timeout: 1500 }));
    expect(guarded).toMatchObject({ status: 408, code: "SCRAPE_TIMEOUT" });
  }, 15_000);

  test("a request with LLM formats and no timeout gets at least 60 s", () => {
    const formats = (f: Parameters<typeof normalizeFormats>[0]) => normalizeFormats(f);
    expect(scrapeTimeout({ timeout: 30_000 }, {}, formats(["markdown"]))).toBe(30_000);
    expect(scrapeTimeout({ timeout: 30_000 }, {}, formats(["markdown", "summary"]))).toBe(60_000);
    expect(scrapeTimeout({ timeout: 30_000 }, { checkPromptInjection: true }, formats(["markdown"]))).toBe(60_000);
    expect(scrapeTimeout({ timeout: 90_000 }, {}, formats(["summary"]))).toBe(90_000);
    expect(scrapeTimeout({ timeout: 30_000 }, { timeout: 5000 }, formats(["summary"]))).toBe(5000);
  });

  test("an unreachable LLM is reported as LLM_UNAVAILABLE naming the endpoint", async () => {
    const engine = testEngine({ llmModel: "m", llmBaseUrl: "http://127.0.0.1:1/v1" });
    const doc = await engine.scrape({ url: `${site.url}/docs/a`, formats: ["markdown", "summary"] });
    expect(doc.summary).toBeUndefined();
    expect(doc.warning).toContain("127.0.0.1:1");
  }, 10_000);
});
