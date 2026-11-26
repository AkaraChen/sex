import { SearchError } from "./errors.ts";
import { adapterOptions, jsonRequest, mappedResult, results } from "./http.ts";
import type { AdapterOptions, SearchProvider } from "./types.ts";
import { record } from "./validation.ts";

/** SearchResults only; sourcedAnswer and structured outputs stay native. */
export function linkup(options: AdapterOptions): SearchProvider {
  const { apiKey, fetch } = adapterOptions(options);
  return Object.freeze({
    id: "linkup",
    capabilities: Object.freeze({ domainFilters: true, maxIncludeDomains: 100, maxExcludeDomains: 50 }),
    async search(request, { signal }) {
      const body = await jsonRequest(fetch, "https://api.linkup.so/v1/search", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          q: request.query,
          depth: "fast",
          outputType: "searchResults",
          includeImages: false,
          maxResults: request.limit,
          ...(request.includeDomains ? { includeDomains: request.includeDomains } : {}),
          ...(request.excludeDomains ? { excludeDomains: request.excludeDomains } : {}),
        }),
      });
      const retrievedAt = new Date().toISOString();
      return {
        results: results(body.results).map((value) => {
          const row = record(value);
          // Images were explicitly disabled. Never silently normalize a media row.
          if (row.type !== undefined && row.type !== "text") throw new SearchError("invalid_response");
          return mappedResult({ ...row, title: row.name }, "linkup", retrievedAt, { snippet: "content" });
        }),
        usage: null,
        warnings: [],
      };
    },
  } satisfies SearchProvider);
}
