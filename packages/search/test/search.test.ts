import { afterAll, beforeAll, expect, test } from "bun:test";
import { createClient } from "@searxng-js/searxng";
import { SearchBackendError, searchWeb } from "../src/search.ts";

let server: ReturnType<typeof Bun.serve>;
let queries: Array<{ q: string; categories: string | null }> = [];

const result = (url: string, title: string) => ({
  url,
  title,
  content: `content of ${title}`,
  category: "general",
  engine: "x",
  engines: ["x"],
  positions: [1],
  score: 1,
  template: "default",
  parsed_url: null,
});

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const q = url.searchParams.get("q") ?? "";
      queries.push({ q, categories: url.searchParams.get("categories") });
      return Response.json({
        results: [
          result("https://a.test/", "<em>Alpha</em>"),
          result("https://a.test/", "Alpha again"),
          result("https://b.test/", "Beta"),
        ],
      });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

const client = () => createClient({ baseUrl: server.url.origin });

test("results are deduplicated by URL and cleaned", async () => {
  const { data } = await searchWeb(client(), { query: "test" });
  expect(data.web).toHaveLength(2);
  expect(data.web?.[0]).toMatchObject({
    url: "https://a.test/",
    title: "Alpha",
    description: "content of Alpha",
    position: 1,
  });
  expect(data.web?.[1]?.position).toBe(2);
});

test("limit caps the list", async () => {
  const { data } = await searchWeb(client(), { query: "test", limit: 1 });
  expect(data.web).toHaveLength(1);
});

test("excludeDomains becomes -site: operators", async () => {
  queries = [];
  await searchWeb(client(), { query: "test", excludeDomains: ["a.test"] });
  expect(queries[0]?.q).toBe("test -site:a.test");
});

test("includeDomains costs one query per domain", async () => {
  queries = [];
  const { data } = await searchWeb(client(), { query: "test", includeDomains: ["a.test", "b.test"] });
  expect(queries).toHaveLength(2);
  expect(queries.map((query) => query.q)).toEqual(["test site:a.test", "test site:b.test"]);
  expect(data.web).toHaveLength(2);
});

test("the news source uses the news category and maps fields", async () => {
  queries = [];
  const { data } = await searchWeb(client(), { query: "test", sources: ["news"] });
  expect(queries[0]?.categories).toBe("news");
  expect(data.news?.[0]?.snippet).toBe("content of Alpha");
  expect(data.web).toBeUndefined();
});

test("qdr:h is answered as a day with a warning", async () => {
  const { warnings } = await searchWeb(client(), { query: "test", tbs: "qdr:h" });
  expect(warnings.join()).toContain("qdr:h");
});

test("every query failing is a SearchBackendError", async () => {
  const failing = createClient({ baseUrl: "http://127.0.0.1:9" });
  await expect(searchWeb(failing, { query: "test" })).rejects.toBeInstanceOf(SearchBackendError);
});
