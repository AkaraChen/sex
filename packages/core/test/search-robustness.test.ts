import { afterAll, describe, expect, test } from "bun:test";
import { normalizeDomain } from "../src/search.ts";
import { testCoreEngine } from "./helpers.ts";

let calls = 0;
const queries: string[] = [];
let handler: (call: number) => Response = () => Response.json({ results: [] });
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const u = new URL(req.url);
    if (u.searchParams.get("pageno") !== "1") return Response.json({ results: [] });
    queries.push(u.searchParams.get("q") ?? "");
    return handler(++calls);
  },
});
const engine = testCoreEngine({ searxngUrl: `http://127.0.0.1:${server.port}` });
const hit = { results: [{ url: "https://example.test/a", title: "A", content: "a" }] };

afterAll(async () => {
  await engine.close();
  server.stop(true);
});

const reset = (h: typeof handler) => {
  calls = 0;
  queries.length = 0;
  handler = h;
};

describe("SearXNG robustness", () => {
  test("a 5xx is retried once", async () => {
    reset((call) => (call === 1 ? new Response("boom", { status: 503 }) : Response.json(hit)));
    const { data } = await engine.search({ query: "x" });
    expect(data.web?.[0]?.url).toBe("https://example.test/a");
    expect(calls).toBe(2);
  });

  test("a persistent 5xx fails after one retry", async () => {
    reset(() => new Response("boom", { status: 500 }));
    await expect(engine.search({ query: "x" })).rejects.toMatchObject({ code: "SEARCH_BACKEND_ERROR" });
    expect(calls).toBe(2);
  });

  test("a 4xx is not retried", async () => {
    reset(() => new Response("no", { status: 403 }));
    await expect(engine.search({ query: "x" })).rejects.toMatchObject({ code: "SEARCH_BACKEND_ERROR" });
    expect(calls).toBe(1);
  });

  test("a retry does not outlive the request timeout", async () => {
    reset(() => new Response("boom", { status: 500 }));
    const started = Date.now();
    await expect(engine.search({ query: "x", timeout: 100 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("empty results name the unresponsive engines in the warning", async () => {
    reset(() => Response.json({ results: [], unresponsive_engines: [["google", "CAPTCHA"]] }));
    const { data, warning } = await engine.search({ query: "x" });
    expect(data.web).toEqual([]);
    expect(warning).toContain("google: CAPTCHA");
  });

  test("includeDomains are trimmed and lowercased before they reach the query", async () => {
    reset(() => Response.json(hit));
    await engine.search({ query: "x", includeDomains: ["  Example.TEST "] });
    expect(queries).toEqual(["x site:example.test"]);
  });

  test("an invalid includeDomains entry is a 400", async () => {
    await expect(engine.search({ query: "x", includeDomains: ["a b.com"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(() => normalizeDomain("http://example.com")).toThrow();
    expect(normalizeDomain("*.Example.com")).toBe("example.com");
  });
});

describe("search v2 parameters", () => {
  const seen: URL[] = [];
  const wide = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      seen.push(u);
      if (u.searchParams.get("pageno") !== "1") return Response.json({ results: [] });
      return Response.json({
        results: [
          { url: "https://github.com/a/b", title: "gh", content: "" },
          { url: "https://example.org/paper.pdf", title: "pdf", content: "" },
          { url: "https://arxiv.example/x", title: "sci", content: "", category: "science" },
          { url: "https://other.test/", title: "plain", content: "" },
        ],
      });
    },
  });
  const e = testCoreEngine({ searxngUrl: `http://127.0.0.1:${wide.port}` });
  afterAll(async () => {
    await e.close();
    wide.stop(true);
  });

  test("safe sets safesearch=2, and is absent otherwise", async () => {
    seen.length = 0;
    await e.search({ query: "x", safe: true });
    await e.search({ query: "x" });
    const first = seen.filter((u) => u.searchParams.get("pageno") === "1");
    expect(first[0]?.searchParams.get("safesearch")).toBe("2");
    expect(first[1]?.searchParams.has("safesearch")).toBe(false);
  });

  test("results are tagged with a category", async () => {
    const { data } = await e.search({ query: "x", limit: 10 });
    expect(data.web?.map((r) => r.category)).toEqual(["github", "pdf", "research", undefined]);
  });

  test("unsupported parameters are named in the warning", async () => {
    const { warning } = await e.search({ query: "x", tbs: "sbd:1", country: "DE", location: "Berlin" });
    expect(warning).toContain("tbs");
    expect(warning).toContain("country");
    expect(warning).toContain("location");
    expect((await e.search({ query: "x", tbs: "qdr:w" })).warning).toBeUndefined();
  });

  test("site: filters the results", async () => {
    const { data } = await e.search({ query: "site:github.com x" });
    expect(data.web?.map((r) => r.url)).toEqual(["https://github.com/a/b"]);
  });
});
