import type { CallTime, SearchData, SearchRequest } from "./search.ts";
import { SearchBackendError } from "./search.ts";

/** One place a search can be answered. Anything the request asks for that it cannot honour goes into `warnings`. */
export interface SearchBackend {
  readonly id: string;
  search(request: SearchRequest, time?: CallTime): Promise<{ data: SearchData; warnings: string[] }>;
}

/** Whether the next backend could answer what this one failed. Unknown errors count as transient: a stable bug surfaces on the last backend. */
export function isTransient(err: unknown): boolean {
  return err instanceof SearchBackendError ? err.transient : true;
}

/**
 * Backends in order, first answer wins. Only a transient failure moves on; auth, an invalid
 * request and an empty result never route elsewhere silently (the searchkit fallback philosophy).
 */
export class SearchChain {
  constructor(private readonly backends: readonly SearchBackend[]) {
    if (!backends.length) throw new Error("A search chain needs at least one backend");
    const ids = new Set(backends.map((backend) => backend.id));
    if (ids.size !== backends.length) throw new Error("Every backend in a search chain needs its own id");
  }

  get ids(): string[] {
    return this.backends.map((backend) => backend.id);
  }

  async search(
    request: SearchRequest,
    time?: CallTime,
  ): Promise<{ data: SearchData; warnings: string[]; provider: string }> {
    const warnings: string[] = [];
    for (const [index, backend] of this.backends.entries()) {
      try {
        const answered = await backend.search(request, time);
        return { data: answered.data, warnings: [...warnings, ...answered.warnings], provider: backend.id };
      } catch (err) {
        const next = this.backends[index + 1];
        if (!isTransient(err) || !next) throw err;
        warnings.push(
          `${backend.id} failed and the search moved to ${next.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Unreachable: the last backend either answers or throws.
    throw new SearchBackendError("The search chain is empty");
  }
}

/**
 * The app-side default expressed as an explicit act: a chain with no SearXNG member gets one appended.
 * Nothing about `SearchChain` itself implies a fallback.
 */
export function withSearxngFallback(
  chain: readonly SearchBackend[],
  searxng: SearchBackend | (() => SearchBackend),
): SearchBackend[] {
  const backends = [...chain];
  if (!backends.some((backend) => backend.id === "searxng")) {
    backends.push(typeof searxng === "function" ? searxng() : searxng);
  }
  return backends;
}
