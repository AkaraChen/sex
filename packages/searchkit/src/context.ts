import { SearchError } from "./errors.ts";
import { adapterOptions, jsonRequest, mappedResult, results, usage } from "./http.ts";
import type { AdapterOptions, SearchProvider } from "./types.ts";
import { requestId } from "./validation.ts";

export function context(options: AdapterOptions): SearchProvider {
  const { apiKey, fetch } = adapterOptions(options);
  return Object.freeze({
    id: "context",
    capabilities: Object.freeze({
      domainFilters: true,
      maxIncludeDomains: 100,
      maxExcludeDomains: 100,
      maxQueryLength: 500,
    }),
    async search(request, { signal }) {
      const body = await jsonRequest(fetch, "https://api.context.dev/v1/web/search", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        // The overview says 10–100, while the reference says 1–100. Stay in
        // their intersection; createSearch caps output to the caller's limit.
        body: JSON.stringify({
          query: request.query,
          numResults: Math.max(10, request.limit),
          ...(request.includeDomains ? { includeDomains: request.includeDomains } : {}),
          ...(request.excludeDomains ? { excludeDomains: request.excludeDomains } : {}),
        }),
      });
      const id = requestId(body.request_id);
      if (body.partial !== undefined && typeof body.partial !== "boolean") throw new SearchError("invalid_response");
      const retrievedAt = new Date().toISOString();
      return {
        results: results(body.results).map((row) =>
          mappedResult(row, "context", retrievedAt, { snippet: "description" }, id),
        ),
        usage: usage(body.key_metadata, "credits_consumed", "credits"),
        warnings: body.partial === true ? [{ code: "provider_warning" as const, provider: "context" }] : [],
      };
    },
  } satisfies SearchProvider);
}
