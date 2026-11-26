import { adapterOptions, jsonRequest, mappedResult, results, usage } from "./http.ts";
import type { AdapterOptions, SearchProvider } from "./types.ts";
import { requestId } from "./validation.ts";

export function exa(options: AdapterOptions): SearchProvider {
  const { apiKey, fetch } = adapterOptions(options);
  return Object.freeze({
    id: "exa",
    capabilities: Object.freeze({ domainFilters: true, maxIncludeDomains: 1200, maxExcludeDomains: 1200 }),
    async search(request, { signal }) {
      const body = await jsonRequest(fetch, "https://api.exa.ai/search", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({
          query: request.query,
          numResults: request.limit,
          type: "auto",
          contents: { highlights: true },
          ...(request.includeDomains ? { includeDomains: request.includeDomains } : {}),
          ...(request.excludeDomains ? { excludeDomains: request.excludeDomains } : {}),
        }),
      });
      const id = requestId(body.requestId);
      const retrievedAt = new Date().toISOString();
      return {
        results: results(body.results).map((row) =>
          mappedResult(row, "exa", retrievedAt, { highlights: "highlights", score: "score" }, id),
        ),
        usage: usage(body.costDollars, "total", "usd"),
        warnings:
          (Array.isArray(body.warnings) && body.warnings.length) || (Array.isArray(body.notices) && body.notices.length)
            ? [{ code: "provider_warning" as const, provider: "exa" }]
            : [],
      };
    },
  } satisfies SearchProvider);
}
