import { adapterOptions, jsonRequest, mappedResult, results } from "./http.ts";
import type { AdapterOptions, SearchProvider } from "./types.ts";
import { requestId } from "./validation.ts";

/** Ranked web results from Search API, not Sonar/Agent generated answers. */
export function perplexity(options: AdapterOptions): SearchProvider {
  const { apiKey, fetch } = adapterOptions(options);
  return Object.freeze({
    id: "perplexity",
    capabilities: Object.freeze({
      domainFilters: true,
      maxIncludeDomains: 20,
      maxExcludeDomains: 20,
      mutuallyExclusiveDomainFilters: true,
    }),
    async search(request, { signal }) {
      const body = await jsonRequest(fetch, "https://api.perplexity.ai/search", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query: request.query,
          max_results: request.limit,
          search_type: "web",
          ...(request.includeDomains ? { search_domain_filter: request.includeDomains } : {}),
          ...(request.excludeDomains
            ? { search_domain_filter: request.excludeDomains.map((domain) => `-${domain}`) }
            : {}),
        }),
      });
      const id = requestId(body.id);
      const retrievedAt = new Date().toISOString();
      return {
        results: results(body.results).map((row) =>
          mappedResult(row, "perplexity", retrievedAt, { snippet: "snippet" }, id),
        ),
        usage: null,
        warnings: [],
      };
    },
  } satisfies SearchProvider);
}
