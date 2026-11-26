import { SearchError } from "./errors.ts";
import type {
  SearchAttempt,
  SearchClient,
  SearchConfig,
  SearchErrorCode,
  SearchOptions,
  SearchProvider,
  SearchRequest,
  SearchResponse,
  ValidatedSearchRequest,
} from "./types.ts";
import { positiveInteger, validateRequest } from "./validation.ts";

// Provider adapters, one named export each; the registry in @searxng-js/sex-search maps names to them.
export { brave } from "./brave.ts";
export { context } from "./context.ts";
export { SearchError } from "./errors.ts";
export { exa } from "./exa.ts";
export { firecrawl } from "./firecrawl.ts";
export { linkup } from "./linkup.ts";
export { parallel } from "./parallel.ts";
export { perplexity } from "./perplexity.ts";
export { serpapi } from "./serpapi.ts";
export { serper } from "./serper.ts";
export { tavily } from "./tavily.ts";
export { tinyfish } from "./tinyfish.ts";
export type * from "./types.ts";
export { valyu } from "./valyu.ts";
export { you } from "./you.ts";

/** Failures another provider might answer; anything else is an answer or a request bug, not a reason to move on. */
export const transientCodes: ReadonlySet<SearchErrorCode> = new Set([
  "network",
  "rate_limit",
  "unavailable",
  "attempt_timeout",
]);

/**
 * One provider, then its explicit fallbacks, under one total budget and a per-attempt budget.
 * That is the whole orchestration: no silent re-routing, no cache, no background anything.
 */
export function createSearch(config: SearchConfig): SearchClient {
  const providers = [config.provider, ...(config.fallback ?? [])];
  if (providers.some((provider) => !provider?.id || typeof provider.search !== "function"))
    throw new SearchError("configuration");
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length)
    throw new SearchError("configuration");
  const timeoutMs = positiveInteger(config.timeoutMs, 30_000);
  const attemptTimeoutMs = positiveInteger(config.attemptTimeoutMs, timeoutMs);

  async function search(input: SearchRequest, options: SearchOptions = {}): Promise<SearchResponse> {
    const request = validateRequest(input);
    const signal = options.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new SearchError("invalid_request");
    for (const provider of providers) unsupported(provider, request);
    if (signal?.aborted) throw new SearchError("aborted");

    const deadline = Date.now() + timeoutMs;
    const attempts: SearchAttempt[] = [];
    for (const [index, provider] of providers.entries()) {
      const startedAt = Date.now();
      const attemptDeadline = startedAt + Math.min(Math.max(1, deadline - startedAt), attemptTimeoutMs);
      const timers = [AbortSignal.timeout(attemptDeadline - startedAt)];
      if (signal) timers.unshift(signal);
      const attemptSignal = AbortSignal.any(timers);
      let response;
      try {
        response = await provider.search(request, { signal: attemptSignal });
      } catch (cause) {
        const error = classify(cause, signal, attemptDeadline, deadline);
        attempts.push({
          provider: provider.id,
          startedAt: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          outcome: "error",
          code: error.code,
          ...(error.status !== undefined ? { status: error.status } : {}),
        });
        if (!transientCodes.has(error.code) || index === providers.length - 1) throw error;
        continue;
      }
      attempts.push({
        provider: provider.id,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        outcome: "success",
      });
      return {
        ...response,
        results: response.results.slice(0, request.limit),
        provider: provider.id,
        attempts,
        warnings: [
          ...response.warnings,
          ...(index > 0 ? [{ code: "fallback_used" as const, provider: provider.id }] : []),
        ],
      };
    }
    throw new SearchError("configuration", { attempts });
  }

  return { web: { search } };
}

/** A request no configured provider can serve fails before any of them sees a billable call. */
function unsupported(provider: SearchProvider, request: ValidatedSearchRequest): void {
  const c = provider.capabilities;
  if (
    (c.mutuallyExclusiveDomainFilters && request.includeDomains && request.excludeDomains) ||
    ((request.includeDomains || request.excludeDomains) && !c.domainFilters) ||
    (request.includeDomains?.length ?? 0) > c.maxIncludeDomains ||
    (request.excludeDomains?.length ?? 0) > c.maxExcludeDomains ||
    (c.maxQueryLength !== undefined && request.query.length > c.maxQueryLength)
  )
    throw new SearchError("unsupported_option");
}

/** Clock first: whoever's budget ran out decides the code, and the caller's cancel always wins. */
function classify(
  cause: unknown,
  signal: AbortSignal | undefined,
  attemptDeadline: number,
  deadline: number,
): SearchError {
  if (signal?.aborted) return new SearchError("aborted");
  const now = Date.now();
  if (now >= deadline) return new SearchError("timeout");
  if (now >= attemptDeadline) return new SearchError("attempt_timeout");
  return cause instanceof SearchError ? cause : new SearchError("provider_error");
}
