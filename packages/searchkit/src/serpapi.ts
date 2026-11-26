import { SearchError } from "./errors.ts";
import { adapterOptions, jsonRequest, mappedResult, results } from "./http.ts";
import type { AdapterOptions, SearchProvider } from "./types.ts";
import { record, requestId } from "./validation.ts";

/** Synchronous Google organic results; one page, no implicit paid pagination. */
export function serpapi(options: AdapterOptions): SearchProvider {
  const { apiKey, fetch } = adapterOptions(options);
  return Object.freeze({
    id: "serpapi",
    capabilities: Object.freeze({ domainFilters: false, maxIncludeDomains: 0, maxExcludeDomains: 0 }),
    async search(request, { signal }) {
      const endpoint = new URL("https://serpapi.com/search.json");
      endpoint.searchParams.set("engine", "google");
      endpoint.searchParams.set("q", request.query);
      endpoint.searchParams.set("api_key", apiKey);
      const body = await jsonRequest(fetch, endpoint, {
        method: "GET",
        signal,
        headers: { Accept: "application/json" },
      });
      const metadata = record(body.search_metadata);
      const information = body.search_information;
      const searchInformation =
        information && typeof information === "object" && !Array.isArray(information)
          ? (information as Record<string, unknown>)
          : undefined;
      // SerpAPI documents this exact Google no-match diagnostic on successful searches.
      // Require every marker and no actual rows; other errors remain terminal.
      const emptySuccess =
        metadata.status === "Success" &&
        body.error === "Google hasn't returned any results for this query." &&
        searchInformation?.total_results === 0 &&
        searchInformation.organic_results_state === "Fully empty" &&
        (body.organic_results === undefined ||
          (Array.isArray(body.organic_results) && body.organic_results.length === 0));
      if ((body.error !== undefined && !emptySuccess) || metadata.status === "Error")
        throw new SearchError("provider_error");
      if (metadata.status !== "Success") throw new SearchError("invalid_response");
      const id = requestId(metadata.id);
      const retrievedAt = new Date().toISOString();
      return {
        results: (emptySuccess ? [] : results(body.organic_results)).map((value) => {
          const row = record(value);
          return mappedResult({ ...row, url: row.link }, "serpapi", retrievedAt, { snippet: "snippet" }, id);
        }),
        usage: null,
        warnings: [],
      };
    },
  } satisfies SearchProvider);
}
