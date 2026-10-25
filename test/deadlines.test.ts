import { afterAll, describe, expect, test } from "bun:test";
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
    const err = await rejection(engine.scrape({ url: `${site.url}/docs/a`, formats: ["summary"] }));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(err.code).toBe("TIMEOUT");
    expect(err.status).toBe(408);
  }, 10_000);

  test("an unreachable LLM is reported as LLM_UNAVAILABLE naming the endpoint", async () => {
    const engine = testEngine({ llmModel: "m", llmBaseUrl: "http://127.0.0.1:1/v1" });
    const err = await rejection(engine.scrape({ url: `${site.url}/docs/a`, formats: ["summary"] }));
    expect(err.code).toBe("LLM_UNAVAILABLE");
    expect(err.message).toContain("127.0.0.1:1");
  }, 10_000);
});
