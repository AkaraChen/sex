import { expect, test } from "bun:test";
import * as searchkit from "@searxng-js/searchkit";
import { ProviderBackend } from "../src/backends/provider.ts";
import { SearchBackendError, type SearchRequest } from "../src/search.ts";

interface Captured {
  body?: Record<string, unknown>;
}

const captured: Captured = {};

const tavilyFetch: searchkit.FetchTransport = async (request) => {
  expect(request.url).toBe("https://api.tavily.com/search");
  captured.body = (await request.json()) as Record<string, unknown>;
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
  const braveFetch: searchkit.FetchTransport = async (request) => {
    expect(request.url).not.toContain("site");
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

const hangingFetch: searchkit.FetchTransport = (request) =>
  new Promise((_resolve, reject) => {
    const abort = () => reject(request.signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (request.signal.aborted) {
      abort();
      return;
    }
    request.signal.addEventListener("abort", abort, { once: true });
  });

test("per-provider timeout throws transient 504 even when request deadline is longer", async () => {
  const slow = new ProviderBackend(searchkit.tavily({ apiKey: "k", fetch: hangingFetch }), 40);
  const err = await rejection(slow.search({ query: "x", timeout: 5_000 }, { deadlineAt: Date.now() + 5_000 }));
  expect(err).toBeInstanceOf(SearchBackendError);
  const backendError = err as SearchBackendError;
  expect(backendError.status).toBe(504);
  expect(backendError.transient).toBe(true);
  expect(backendError.cause).toBeInstanceOf(searchkit.SearchError);
  expect((backendError.cause as searchkit.SearchError).code).toBe("timeout");
});

test("request.timeout and deadlineAt expire as 504 timeout rather than aborted 502", async () => {
  const slow = new ProviderBackend(searchkit.tavily({ apiKey: "k", fetch: hangingFetch }), 5_000);
  const err = await rejection(slow.search({ query: "x", timeout: 40 }, { deadlineAt: Date.now() + 40 }));
  expect(err).toBeInstanceOf(SearchBackendError);
  const backendError = err as SearchBackendError;
  expect(backendError.status).toBe(504);
  expect(backendError.transient).toBe(true);
  expect(backendError.cause).toBeInstanceOf(searchkit.SearchError);
  expect((backendError.cause as searchkit.SearchError).code).toBe("timeout");

  const deadlineOnly = await rejection(slow.search({ query: "x" }, { deadlineAt: Date.now() + 40 }));
  expect(deadlineOnly).toBeInstanceOf(SearchBackendError);
  expect((deadlineOnly as SearchBackendError).status).toBe(504);
  expect((deadlineOnly as SearchBackendError).transient).toBe(true);
  expect(((deadlineOnly as SearchBackendError).cause as searchkit.SearchError).code).toBe("timeout");
});

test("already-expired deadlineAt throws transient 504 without calling the provider", async () => {
  let calls = 0;
  const counted = new ProviderBackend(
    searchkit.tavily({
      apiKey: "k",
      fetch: async (request) => {
        calls++;
        return tavilyFetch(request);
      },
    }),
    5_000,
  );
  const err = await rejection(counted.search({ query: "x" }, { deadlineAt: Date.now() }));
  expect(err).toBeInstanceOf(SearchBackendError);
  expect((err as SearchBackendError).status).toBe(504);
  expect((err as SearchBackendError).transient).toBe(true);
  expect(calls).toBe(0);
});

test("explicit caller abort stays non-transient and wins over an expired deadline", async () => {
  const slow = new ProviderBackend(searchkit.tavily({ apiKey: "k", fetch: hangingFetch }), 5_000);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const err = await rejection(
    slow.search({ query: "x" }, { signal: controller.signal, deadlineAt: Date.now() + 5_000 }),
  );
  expect(err).toBeInstanceOf(SearchBackendError);
  const backendError = err as SearchBackendError;
  expect(backendError.transient).toBe(false);
  expect(backendError.cause).toBeInstanceOf(searchkit.SearchError);
  expect((backendError.cause as searchkit.SearchError).code).toBe("aborted");

  const preAborted = new AbortController();
  preAborted.abort();
  const early = await rejection(
    slow.search({ query: "x" }, { signal: preAborted.signal, deadlineAt: Date.now() - 10 }),
  );
  expect(early).toBeInstanceOf(SearchBackendError);
  expect((early as SearchBackendError).transient).toBe(false);
  expect(((early as SearchBackendError).cause as searchkit.SearchError).code).toBe("aborted");
});
