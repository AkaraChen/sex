import { SearchError } from "./errors.ts";
import { adapterOptions, jsonRequest, mappedResult, results } from "./http.ts";
import type { AdapterOptions, SearchProvider } from "./types.ts";
import { optionalNumber, record } from "./validation.ts";

export function serper(options: AdapterOptions): SearchProvider {
  const { apiKey, fetch } = adapterOptions(options);
  return Object.freeze({
    id: "serper",
    capabilities: Object.freeze({ domainFilters: false, maxIncludeDomains: 0, maxExcludeDomains: 0 }),
    async search(request, { signal }) {
      const body = await jsonRequest(fetch, "https://google.serper.dev/search", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
        body: JSON.stringify({ q: request.query, num: request.limit }),
      });
      if (body.error !== undefined || (body.message !== undefined && body.organic === undefined))
        throw new SearchError("provider_error");
      const credits = optionalNumber(body.credits);
      if (credits !== undefined && credits < 0) throw new SearchError("invalid_response");
      const retrievedAt = new Date().toISOString();
      return {
        results: results(body.organic).map((value) => {
          const row = record(value);
          return mappedResult({ ...row, url: row.link }, "serper", retrievedAt, { snippet: "snippet" });
        }),
        usage: credits === undefined ? null : { unit: "credits" as const, value: credits },
        warnings: [],
      };
    },
  } satisfies SearchProvider);
}
