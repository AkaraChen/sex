import { SearchError } from "./errors.ts";
import { mappedResult } from "./http.ts";
import type { SearchErrorCode, SearchProvider, SearchResult, SearchUsage, ValidatedSearchRequest } from "./types.ts";

export type MockResult = Omit<SearchResult, "provenance">;
export type MockOutcome =
  | {
      type: "success";
      results?: readonly MockResult[];
      usage?: SearchUsage | null;
      delayMs?: number;
    }
  | {
      type: "error";
      code: SearchErrorCode;
      status?: number;
      retryAfterMs?: number;
      delayMs?: number;
    };
export interface MockCall {
  readonly request: ValidatedSearchRequest;
  readonly signal: AbortSignal;
}
export interface MockProvider extends SearchProvider {
  readonly calls: readonly MockCall[];
}
export interface MockOptions {
  id?: string;
  /** Consumed once per call in invocation order; exhaustion is a configuration error. */
  outcomes?: readonly MockOutcome[];
  delayMs?: number;
}
const fixture: readonly MockResult[] = [
  {
    url: "https://example.com/search",
    title: "A clear search interface",
    snippet: "One request, explicit providers, visible provenance.",
  },
  {
    url: "https://example.org/reference",
    title: "Search API reference",
    snippet: "Small contracts make integration easier to inspect.",
  },
  {
    url: "https://example.net/guide",
    title: "Build with web sources",
    snippet: "Keep source URLs and provider-native relevance together.",
  },
];

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new SearchError("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
/** Key-free, deterministic fixtures. Each instance owns its queue and recorded calls. */
export function createMockProvider(options: MockOptions = {}): MockProvider {
  const id = options.id ?? "mock";
  const delayMs = options.delayMs ?? 0;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > 2_147_483_647) {
    throw new SearchError("configuration");
  }
  const outcomes = options.outcomes ? structuredClone(options.outcomes) : undefined;
  if (
    outcomes?.some(
      (outcome) =>
        outcome.delayMs !== undefined &&
        (!Number.isFinite(outcome.delayMs) || outcome.delayMs < 0 || outcome.delayMs > 2_147_483_647),
    )
  )
    throw new SearchError("configuration");
  const calls: MockCall[] = [];
  return Object.freeze({
    id,
    capabilities: Object.freeze({ domainFilters: true, maxIncludeDomains: 1200, maxExcludeDomains: 1200 }),
    get calls() {
      return Object.freeze([...calls]);
    },
    async search(request, { signal }) {
      const index = calls.length;
      calls.push(Object.freeze({ request: structuredClone(request), signal }));
      const outcome = outcomes ? outcomes[index] : { type: "success" as const };
      if (!outcome) throw new SearchError("configuration");
      await wait(outcome.delayMs ?? delayMs, signal);
      if (outcome.type === "error")
        throw new SearchError(outcome.code, {
          ...(outcome.status !== undefined ? { status: outcome.status } : {}),
          ...(outcome.retryAfterMs !== undefined ? { retryAfterMs: outcome.retryAfterMs } : {}),
        });
      const retrievedAt = new Date().toISOString();
      const matches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
      const rows = (outcome.results ?? fixture)
        .map((row) =>
          mappedResult(row, id, retrievedAt, { snippet: "snippet", highlights: "highlights", score: "score" }),
        )
        .filter((row) => {
          const host = new URL(row.url).hostname;
          return (
            (!request.includeDomains || request.includeDomains.some((d) => matches(host, d))) &&
            !request.excludeDomains?.some((d) => matches(host, d))
          );
        })
        .slice(0, request.limit);
      return { results: rows, usage: outcome.usage ?? null, warnings: [] };
    },
  } satisfies MockProvider);
}
