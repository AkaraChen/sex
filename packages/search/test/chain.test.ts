import { expect, test } from "bun:test";
import type { SearchProvider } from "@searxng-js/searchkit";
import { ProviderBackend } from "../src/backends/provider.ts";
import { type SearchBackend, SearchChain, withSearxngFallback } from "../src/chain.ts";
import { SearchBackendError, type SearchData } from "../src/search.ts";

const answer = (id: string): SearchBackend => ({
  id,
  async search() {
    return { data: { web: [{ url: `https://${id}.test/`, position: 1 }] }, warnings: [`${id} answered`] };
  },
});

const failing = (id: string, err: Error): SearchBackend => ({
  id,
  async search(): Promise<{ data: SearchData; warnings: string[] }> {
    throw err;
  },
});

test("a transient failure moves to the next backend and keeps the warning trail", async () => {
  const chain = new SearchChain([
    failing("primary", new SearchBackendError("down", 503)),
    { ...answer("backup"), id: "backup" },
  ]);
  const result = await chain.search({ query: "test" });
  expect(result.provider).toBe("backup");
  expect(result.warnings).toEqual(["primary failed and the search moved to backup: down", "backup answered"]);
});

test("a non-transient failure does not move to the next backend", async () => {
  const backup = answer("backup");
  const chain = new SearchChain([
    failing("primary", new SearchBackendError("denied", 401, { transient: false })),
    backup,
  ]);
  const err = await chain.search({ query: "test" }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(SearchBackendError);
  expect((err as SearchBackendError).transient).toBe(false);
});

test("an unknown error counts as transient, and the last failure is what throws", async () => {
  const chain = new SearchChain([failing("a", new Error("boom a")), failing("b", new Error("boom b"))]);
  const err = await chain.search({ query: "test" }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe("boom b");
});

test("a chain needs backends with distinct ids", () => {
  expect(() => new SearchChain([])).toThrow("at least one");
  expect(() => new SearchChain([answer("x"), answer("x")])).toThrow("own id");
});

test("withSearxngFallback appends once and never duplicates", () => {
  const appended = withSearxngFallback([answer("tavily")], answer("searxng"));
  expect(appended.map((backend) => backend.id)).toEqual(["tavily", "searxng"]);
  const kept = withSearxngFallback([answer("searxng"), answer("brave")], answer("other"));
  expect(kept.map((backend) => backend.id)).toEqual(["searxng", "brave"]);
});

const hangingProvider = (id: string, onCall?: () => void): SearchProvider => ({
  id,
  capabilities: { domainFilters: false, maxIncludeDomains: 0, maxExcludeDomains: 0 },
  search(_request, options) {
    onCall?.();
    return new Promise((_resolve, reject) => {
      const signal = options?.signal;
      const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  },
});

test("per-provider timeout falls back to the next backend when total deadline remains", async () => {
  const chain = new SearchChain([new ProviderBackend(hangingProvider("primary"), 40), answer("backup")]);
  const result = await chain.search({ query: "test", timeout: 5_000 }, { deadlineAt: Date.now() + 5_000 });
  expect(result.provider).toBe("backup");
  expect(result.warnings[0]).toContain("primary failed and the search moved to backup");
  expect(result.warnings[1]).toBe("backup answered");
});

test("total deadline expiry stops the chain with 504 without calling subsequent backends", async () => {
  let backupCalls = 0;
  const backup: SearchBackend = {
    id: "backup",
    async search() {
      backupCalls++;
      return { data: { web: [] }, warnings: [] };
    },
  };
  const chain = new SearchChain([new ProviderBackend(hangingProvider("primary"), 5_000), backup]);
  const err = await chain.search({ query: "test", timeout: 40 }, { deadlineAt: Date.now() + 40 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(SearchBackendError);
  expect((err as SearchBackendError).status).toBe(504);
  expect(backupCalls).toBe(0);

  let primaryCalls = 0;
  const expiredChain = new SearchChain([
    new ProviderBackend(
      hangingProvider("primary", () => {
        primaryCalls++;
      }),
      5_000,
    ),
    backup,
  ]);
  const expiredErr = await expiredChain.search({ query: "test" }, { deadlineAt: Date.now() - 10 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(expiredErr).toBeInstanceOf(SearchBackendError);
  expect((expiredErr as SearchBackendError).status).toBe(504);
  expect(primaryCalls).toBe(0);
  expect(backupCalls).toBe(0);
});

test("caller AbortSignal cancellation stops the chain immediately without fallback", async () => {
  let backupCalls = 0;
  const backup: SearchBackend = {
    id: "backup",
    async search() {
      backupCalls++;
      return { data: { web: [] }, warnings: [] };
    },
  };
  const chain = new SearchChain([new ProviderBackend(hangingProvider("primary"), 5_000), backup]);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const err = await chain.search({ query: "test" }, { signal: controller.signal, deadlineAt: Date.now() + 5_000 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(SearchBackendError);
  expect((err as SearchBackendError).transient).toBe(false);
  expect(backupCalls).toBe(0);
});
