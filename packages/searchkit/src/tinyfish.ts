import { adapterOptions, jsonRequest, mappedResult, results } from "./http.ts";
import type { AdapterOptions, SearchProvider } from "./types.ts";

export function tinyfish(options: AdapterOptions): SearchProvider {
  const { apiKey, fetch } = adapterOptions(options);
  // 100 per list is an SDK policy, not a documented TinyFish native maximum.
  return Object.freeze({
    id: "tinyfish",
    capabilities: Object.freeze({ domainFilters: true, maxIncludeDomains: 100, maxExcludeDomains: 100 }),
    async search(request, { signal }) {
      const url = new URL("https://api.search.tinyfish.ai");
      url.searchParams.set("query", request.query);
      url.searchParams.set("domain_type", "web");
      url.searchParams.set("page", "0");
      if (request.includeDomains) url.searchParams.set("include_domains", request.includeDomains.join(","));
      if (request.excludeDomains) url.searchParams.set("exclude_domains", request.excludeDomains.join(","));
      // No documented count/limit parameter. Fetch one page; never auto-paginate.
      const body = await jsonRequest(fetch, url, {
        method: "GET",
        signal,
        headers: { Accept: "application/json", "X-API-Key": apiKey },
      });
      const retrievedAt = new Date().toISOString();
      return {
        results: results(body.results).map((row) => mappedResult(row, "tinyfish", retrievedAt, { snippet: "snippet" })),
        usage: null,
        warnings: [],
      };
    },
  } satisfies SearchProvider);
}
