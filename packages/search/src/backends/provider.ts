import {
  brave,
  context as contextdev,
  createSearch,
  exa,
  firecrawl,
  linkup,
  parallel,
  perplexity,
  SearchError,
  type SearchProvider,
  serpapi,
  serper,
  tavily,
  tinyfish,
  valyu,
  you,
} from "@searxng-js/searchkit";
import type { SearchBackend } from "../chain.ts";
import type { CallTime, SearchData, SearchRequest } from "../search.ts";
import { SearchBackendError } from "../search.ts";

/** The names a sex chain may carry, matching `SEX_SEARCH_PROVIDER`. `searxng` lives next door. */
export const PROVIDERS: Record<string, (apiKey: string) => SearchProvider> = {
  brave: (apiKey) => brave({ apiKey }),
  context: (apiKey) => contextdev({ apiKey }),
  exa: (apiKey) => exa({ apiKey }),
  firecrawl: (apiKey) => firecrawl({ apiKey }),
  linkup: (apiKey) => linkup({ apiKey }),
  parallel: (apiKey) => parallel({ apiKey }),
  perplexity: (apiKey) => perplexity({ apiKey }),
  serpapi: (apiKey) => serpapi({ apiKey }),
  serper: (apiKey) => serper({ apiKey }),
  tavily: (apiKey) => tavily({ apiKey }),
  tinyfish: (apiKey) => tinyfish({ apiKey }),
  valyu: (apiKey) => valyu({ apiKey }),
  you: (apiKey) => you({ apiKey }),
};

/** searchkit codes another backend could survive, with the status the failure reports. */
const TRANSIENT: Record<string, number> = {
  network: 502,
  unavailable: 503,
  rate_limit: 429,
  timeout: 504,
  attempt_timeout: 504,
};
const NON_TRANSIENT_STATUS = 502;

/** The SDK carries 1–20 results; the Firecrawl shape accepts up to 100. */
const PROVIDER_LIMIT = 20;
const DEFAULT_LIMIT = 10;

/** Firecrawl fields the normalized contract cannot carry: deleted and named, never silently dropped. */
const REFUSED: Array<[field: string, warning: (value: unknown) => string]> = [
  ["tbs", (value) => `tbs "${String(value)}" is not supported and was ignored`],
  ["lang", (value) => `lang "${String(value)}" is not supported and was ignored`],
  ["safe", () => "safe is not supported and was ignored"],
  ["scrapeOptions", () => "scrapeOptions is not supported: results are not scraped"],
  ["country", () => "country is not supported and was ignored"],
  ["location", () => "location is not supported and was ignored"],
  ["zeroDataRetention", () => "zeroDataRetention is not supported"],
];

/**
 * One searchkit provider, seen from the chain: refuse what it cannot carry, call it once,
 * turn the normalized results back into `data.web`. Nothing else happens here.
 */
export class ProviderBackend implements SearchBackend {
  readonly id: string;

  constructor(
    private readonly provider: SearchProvider,
    private readonly timeoutMs?: number,
  ) {
    this.id = provider.id;
  }

  async search(request: SearchRequest, time?: CallTime): Promise<{ data: SearchData; warnings: string[] }> {
    const warnings: string[] = [];

    const nonWeb = (request.sources ?? ["web"]).map(kind).filter((source) => source !== "web");
    if (nonWeb.length) warnings.push(`sources: ${nonWeb.join(", ")} is answered as web`);
    const categories = (request.categories ?? []).map(kind);
    if (categories.length) warnings.push(`categories is not supported and was ignored (${categories.join(", ")})`);
    for (const [field, warning] of REFUSED) {
      const value = request[field];
      if (value !== undefined && value !== false) warnings.push(warning(value));
    }
    const wanted = request.limit ?? DEFAULT_LIMIT;
    const limit = Math.min(wanted, PROVIDER_LIMIT);
    if (wanted > PROVIDER_LIMIT) warnings.push(`limit is capped at ${PROVIDER_LIMIT}`);
    const domains = this.filters(request, warnings);

    let response;
    try {
      response = await createSearch({
        provider: this.provider,
        timeoutMs: request.timeout ?? this.timeoutMs ?? 30_000,
      }).web.search({ query: request.query, limit, ...domains }, { signal: composeSignal(time) });
    } catch (err) {
      throw asChainFailure(err, this.id);
    }
    for (const warning of response.warnings) warnings.push(`${warning.provider}: ${warning.code}`);

    const web: SearchData["web"] = response.results.map((result, index) => ({
      url: result.url,
      ...(result.title ? { title: result.title } : {}),
      description: result.snippet ?? (result.highlights?.length ? result.highlights.join(" ") : undefined),
      position: index + 1,
    }));
    return { data: { web }, warnings };
  }

  /** Domain filters follow the provider's declared capabilities; what does not fit becomes a warning. */
  private filters(
    request: SearchRequest,
    warnings: string[],
  ): { includeDomains?: string[]; excludeDomains?: string[] } {
    const capabilities = this.provider.capabilities;
    let includeDomains = request.includeDomains;
    let excludeDomains = request.excludeDomains;
    if ((includeDomains?.length || excludeDomains?.length) && !capabilities.domainFilters) {
      warnings.push("includeDomains and excludeDomains are not supported and were ignored");
      return {};
    }
    if (capabilities.mutuallyExclusiveDomainFilters && includeDomains?.length && excludeDomains?.length) {
      warnings.push("includeDomains and excludeDomains cannot be combined; only includeDomains was used");
      excludeDomains = undefined;
    }
    if (includeDomains && includeDomains.length > capabilities.maxIncludeDomains) {
      warnings.push(`Only the first ${capabilities.maxIncludeDomains} includeDomains are searched`);
      includeDomains = includeDomains.slice(0, capabilities.maxIncludeDomains);
    }
    if (excludeDomains && excludeDomains.length > capabilities.maxExcludeDomains) {
      warnings.push(`Only the first ${capabilities.maxExcludeDomains} excludeDomains are searched`);
      excludeDomains = excludeDomains.slice(0, capabilities.maxExcludeDomains);
    }
    return {
      ...(includeDomains?.length ? { includeDomains: [...includeDomains] } : {}),
      ...(excludeDomains?.length ? { excludeDomains: [...excludeDomains] } : {}),
    };
  }
}

/** searchkit codes become chain-visible failures; only transient ones let the chain move on. */
function asChainFailure(err: unknown, id: string): unknown {
  if (!(err instanceof SearchError)) return err;
  const status = TRANSIENT[err.code] ?? NON_TRANSIENT_STATUS;
  return new SearchBackendError(`${id}: ${err.message}`, status, { cause: err, transient: err.code in TRANSIENT });
}

function kind(source: string | { type: string }): string {
  return typeof source === "string" ? source : source.type;
}

/** The caller's signal plus any deadline it carries, the same composition `searchWeb` does. */
function composeSignal(time?: CallTime): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (time?.signal) signals.push(time.signal);
  if (time?.deadlineAt !== undefined) signals.push(AbortSignal.timeout(Math.max(1, time.deadlineAt - Date.now())));
  return signals.length ? AbortSignal.any(signals) : undefined;
}
