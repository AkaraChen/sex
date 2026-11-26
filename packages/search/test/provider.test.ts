import { expect, test } from "bun:test";
import * as searchkit from "@searxng-js/searchkit";
import { ProviderBackend } from "../src/backends/provider.ts";
import { SearchBackendError, type SearchRequest } from "../src/search.ts";

interface Captured {
  body?: Record<string, unknown>;
}

const captured: Captured = {};

const tavilyFetch: searchkit.FetchTransport = async (input, init) => {
  expect(String(input)).toBe("https://api.tavily.com/search");
  captured.body = JSON.parse(String(init?.body));
  return Response.json({
    results: [{ url: "https://t.test/", title: "Tavily hit", content: "the snippet", score: 0.9 }],
    usage: { credits: 1 },
    request_id: "r1",
  });
};

const backend = (fetch: searchkit.FetchTransport) =>
  new ProviderBackend(searchkit.tavily({ apiKey: "k", fetch }), 5_000);

const rejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

test("results come back in the Firecrawl web shape", async () => {
  const { data, warnings } = await backend(tavilyFetch).search({ query: "test" });
  expect(warnings).toEqual([]);
  expect(data.web).toEqual([{ url: "https://t.test/", title: "Tavily hit", description: "the snippet", position: 1 }]);
  expect(captured.body).toMatchObject({ query: "test", max_results: 10 });
});

test("everything the provider contract cannot carry is refused with a warning", async () => {
  const request: SearchRequest = {
    query: "test",
    sources: ["news", "images"],
    categories: ["github"],
    tbs: "qdr:w",
    lang: "zh-CN",
    safe: true,
    scrapeOptions: { formats: ["markdown"] },
    country: "us",
    location: "Berlin",
    zeroDataRetention: true,
    limit: 50,
  };
  const { warnings } = await backend(tavilyFetch).search(request);
  const joined = warnings.join("; ");
  expect(joined).toContain("news, images is answered as web");
  expect(joined).toContain("categories");
  expect(joined).toContain("qdr:w");
  expect(joined).toContain("lang");
  expect(joined).toContain("safe");
  expect(joined).toContain("scrapeOptions");
  expect(joined).toContain("country");
  expect(joined).toContain("limit is capped at 20");
  expect(captured.body).toMatchObject({ max_results: 20 });
});

test("domain filters follow the provider's declared capabilities", async () => {
  let seen: searchkit.ValidatedSearchRequest | undefined;
  const tiny: searchkit.SearchProvider = {
    id: "tiny",
    capabilities: { domainFilters: true, maxIncludeDomains: 1, maxExcludeDomains: 0 },
    async search(request) {
      seen = request;
      return { results: [], usage: null, warnings: [] };
    },
  };
  const { warnings } = await new ProviderBackend(tiny).search({
    query: "test",
    includeDomains: ["a.test", "b.test"],
    excludeDomains: ["c.test"],
  });
  expect(seen?.includeDomains).toEqual(["a.test"]);
  const joined = warnings.join("; ");
  expect(joined).toContain("Only the first 1 includeDomains are searched");
  expect(joined).toContain("Only the first 0 excludeDomains are searched");
});

test("a provider without domain support loses the filters to a warning, not an error", async () => {
  const braveFetch: searchkit.FetchTransport = async (input) => {
    expect(String(input)).not.toContain("site");
    return Response.json({ web: { results: [{ url: "https://b.test/", title: "B", description: "d" }] } });
  };
  const { data, warnings } = await new ProviderBackend(searchkit.brave({ apiKey: "k", fetch: braveFetch })).search({
    query: "test",
    includeDomains: ["a.test"],
  });
  expect(data.web?.[0]?.url).toBe("https://b.test/");
  expect(warnings.join()).toContain("includeDomains and excludeDomains are not supported and were ignored");
});

test("provider auth failures are SearchBackendErrors that will not move the chain", async () => {
  const err = await rejection(
    backend(() => Promise.resolve(new Response("no", { status: 401 }))).search({ query: "x" }),
  );
  expect(err).toBeInstanceOf(SearchBackendError);
  expect((err as SearchBackendError).transient).toBe(false);
});

test("rate limits stay transient so the chain can move on", async () => {
  const err = await rejection(
    backend(() => Promise.resolve(new Response("no", { status: 429 }))).search({ query: "x" }),
  );
  expect(err).toBeInstanceOf(SearchBackendError);
  expect((err as SearchBackendError).transient).toBe(true);
});
