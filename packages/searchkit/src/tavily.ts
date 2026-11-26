import { adapterOptions, jsonRequest, mappedResult, results, usage } from "./http.ts";
import type { AdapterOptions, SearchProvider } from "./types.ts";
import { requestId } from "./validation.ts";

export function tavily(options: AdapterOptions): SearchProvider {
  const { apiKey, fetch } = adapterOptions(options);
  return Object.freeze({
    id: "tavily",
    capabilities: Object.freeze({ domainFilters: true, maxIncludeDomains: 300, maxExcludeDomains: 150 }),
    async search(request, { signal }) {
      const body = await jsonRequest(fetch, "https://api.tavily.com/search", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query: request.query,
          max_results: request.limit,
          search_depth: "basic",
          include_usage: true,
          auto_parameters: false,
          include_answer: false,
          include_raw_content: false,
          ...(request.includeDomains
            ? { include_domains: request.includeDomains, include_domains_mode: "restrict" }
            : {}),
          ...(request.excludeDomains ? { exclude_domains: request.excludeDomains } : {}),
        }),
      });
      const id = requestId(body.request_id);
      const retrievedAt = new Date().toISOString();
      return {
        results: results(body.results).map((row) =>
          mappedResult(row, "tavily", retrievedAt, { snippet: "content", score: "score" }, id),
        ),
        usage: usage(body.usage, "credits", "credits"),
        warnings: [],
      };
    },
  } satisfies SearchProvider);
}
