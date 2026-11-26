import { SearchError } from "./errors.ts";
import { adapterOptions, jsonRequest, mappedResult, results } from "./http.ts";
import type { AdapterOptions, SearchProvider } from "./types.ts";
import { record } from "./validation.ts";

export function brave(options: AdapterOptions): SearchProvider {
  const { apiKey, fetch } = adapterOptions(options);
  return Object.freeze({
    id: "brave",
    capabilities: Object.freeze({ domainFilters: false, maxIncludeDomains: 0, maxExcludeDomains: 0 }),
    async search(request, { signal }) {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", request.query);
      url.searchParams.set("count", String(request.limit));
      url.searchParams.set("extra_snippets", "true");
      const body = await jsonRequest(fetch, url, {
        method: "GET",
        signal,
        headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
      });
      // Brave may omit the web section for a legitimate response with no web hits.
      let rows: unknown[];
      if (body.web === undefined) {
        if (typeof record(body.query).original !== "string") throw new SearchError("invalid_response");
        rows = [];
      } else rows = results(record(body.web).results);
      const retrievedAt = new Date().toISOString();
      return {
        results: rows.map((row) =>
          mappedResult(row, "brave", retrievedAt, { snippet: "description", highlights: "extra_snippets" }),
        ),
        usage: null,
        warnings: [],
      };
    },
  } satisfies SearchProvider);
}
