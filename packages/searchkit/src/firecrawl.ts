import { SearchError } from "./errors.ts";
import { adapterOptions, jsonRequest, mappedResult, results } from "./http.ts";
import type { AdapterOptions, SearchProvider } from "./types.ts";
import { optionalNumber, optionalString, record, requestId } from "./validation.ts";

export function firecrawl(options: AdapterOptions): SearchProvider {
  const { apiKey, fetch } = adapterOptions(options);
  return Object.freeze({
    id: "firecrawl",
    capabilities: Object.freeze({
      domainFilters: true,
      // Conservative SDK policy: the native schema does not publish list maxima.
      maxIncludeDomains: 100,
      maxExcludeDomains: 100,
      mutuallyExclusiveDomainFilters: true,
      maxQueryLength: 500,
    }),
    async search(request, { signal }) {
      const body = await jsonRequest(fetch, "https://api.firecrawl.dev/v2/search", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query: request.query,
          limit: request.limit,
          sources: [{ type: "web" }],
          highlights: false,
          ...(request.includeDomains ? { includeDomains: request.includeDomains } : {}),
          ...(request.excludeDomains ? { excludeDomains: request.excludeDomains } : {}),
        }),
      });
      if (body.success !== true) throw new SearchError(body.success === false ? "provider_error" : "invalid_response");
      const id = requestId(body.id);
      const credits = optionalNumber(body.creditsUsed);
      if (credits !== undefined && (credits < 0 || !Number.isInteger(credits)))
        throw new SearchError("invalid_response");
      const warning = optionalString(body.warning);
      const retrievedAt = new Date().toISOString();
      return {
        results: results(record(body.data).web).map((row) =>
          mappedResult(row, "firecrawl", retrievedAt, { snippet: "description" }, id),
        ),
        usage: credits === undefined ? null : { unit: "credits" as const, value: credits },
        warnings: warning ? [{ code: "provider_warning" as const, provider: "firecrawl" }] : [],
      };
    },
  } satisfies SearchProvider);
}
