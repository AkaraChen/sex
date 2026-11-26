import { expect, test } from "bun:test";
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
