import type { SearchError } from "./errors.ts";

export interface SearchRequest {
  query: string;
  /** Output ceiling (1–20; default 5). Providers may return fewer results. */
  limit?: number;
  /** Hostnames only; no schemes, paths, ports or wildcards. */
  includeDomains?: readonly string[];
  excludeDomains?: readonly string[];
}

export interface ValidatedSearchRequest extends SearchRequest {
  limit: number;
}
export interface SearchOptions {
  signal?: AbortSignal;
}

export type SearchErrorCode =
  | "invalid_request"
  | "unsupported_option"
  | "configuration"
  | "auth"
  | "rate_limit"
  | "network"
  | "unavailable"
  | "attempt_timeout"
  | "timeout"
  | "aborted"
  | "invalid_response"
  | "provider_error";

/** One dispatch to one provider; the trail on every response and every failure. */
export interface SearchAttempt {
  provider: string;
  startedAt: string;
  durationMs: number;
  outcome: "success" | "error";
  code?: SearchErrorCode;
  status?: number;
}

export interface SearchResult {
  url: string;
  title?: string;
  snippet?: string;
  highlights?: readonly string[];
  /** Provider-native relevance; not comparable across providers. */
  score?: number;
  provenance: {
    provider: string;
    sourceUrl: string;
    /** SDK retrieval time, not publication time. */
    retrievedAt: string;
    requestId?: string;
  };
}

export interface SearchUsage {
  unit: "usd" | "credits";
  value: number;
}
export interface SearchWarning {
  code: "fallback_used" | "provider_warning";
  provider: string;
}
export interface ProviderResponse {
  results: readonly SearchResult[];
  usage: SearchUsage | null;
  warnings: readonly SearchWarning[];
}
export interface SearchResponse extends ProviderResponse {
  provider: string;
  attempts: readonly SearchAttempt[];
}

/** Custom providers must honour the capabilities they declare and the signal they are given. */
export interface SearchProvider {
  readonly id: string;
  readonly capabilities: {
    readonly domainFilters: boolean;
    /** Refuse simultaneous include/exclude before anything dispatches. */
    readonly mutuallyExclusiveDomainFilters?: boolean;
    readonly maxIncludeDomains: number;
    readonly maxExcludeDomains: number;
    /** Optional query ceiling in UTF-16 code units. */
    readonly maxQueryLength?: number;
  };
  search(request: ValidatedSearchRequest, options: { signal: AbortSignal }): Promise<ProviderResponse>;
}

export interface SearchConfig {
  provider: SearchProvider;
  /** Tried, in order, only after a transient failure. No silent re-routing. */
  fallback?: readonly SearchProvider[];
  /** The whole call, every attempt included. Default 30,000. */
  timeoutMs?: number;
  /** Each attempt, still bounded by timeoutMs. Default: the whole-call budget. */
  attemptTimeoutMs?: number;
}

export type FetchTransport = (request: Request, init?: RequestInit) => Promise<Response>;
export interface AdapterOptions {
  apiKey: string;
  fetch?: FetchTransport;
}

export interface SearchClient {
  web: {
    search(request: SearchRequest, options?: SearchOptions): Promise<SearchResponse>;
  };
}
