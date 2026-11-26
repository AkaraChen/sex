import { SearchError } from "./errors.ts";
import { adapterOptions, jsonRequest, mappedResult, results } from "./http.ts";
import type { AdapterOptions, SearchProvider } from "./types.ts";
import { optionalStrings, record, requestId } from "./validation.ts";

/** Web section only, snippets only. News/knowledge/extraction remain native. */
export function you(options: AdapterOptions): SearchProvider {
  const { apiKey, fetch } = adapterOptions(options);
  return Object.freeze({
    id: "you",
    capabilities: Object.freeze({
      domainFilters: true,
      maxIncludeDomains: 500,
      maxExcludeDomains: 5000,
      mutuallyExclusiveDomainFilters: true,
    }),
    async search(request, { signal }) {
      const body = await jsonRequest(fetch, "https://ydc-index.io/v1/search", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify({
          query: request.query,
          count: request.limit,
          ...(request.includeDomains ? { include_domains: request.includeDomains } : {}),
          ...(request.excludeDomains ? { exclude_domains: request.excludeDomains } : {}),
        }),
      });
      const id = body.metadata === undefined ? undefined : requestId(record(body.metadata).search_uuid);
      const sections = record(body.results);
      let web: unknown[];
      if (sections.web === undefined) {
        // Query classification can yield a news-only section. Those are not web hits.
        if (!Array.isArray(sections.news)) throw new SearchError("invalid_response");
        web = [];
      } else web = results(sections.web);
      const retrievedAt = new Date().toISOString();
      return {
        results: web.map((value) => {
          const row = record(value);
          const snippets = optionalStrings(row.snippets);
          const mapped = mappedResult(row, "you", retrievedAt, { snippet: "description" }, id);
          return mapped.snippet === undefined && snippets ? { ...mapped, snippet: snippets.join("\n") } : mapped;
        }),
        usage: null,
        warnings: [],
      };
    },
  } satisfies SearchProvider);
}
