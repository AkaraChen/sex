import { expect, test } from "bun:test";
import { createSearch, SearchError } from "../src/index.ts";
import { createMockProvider } from "../src/testing.ts";

test("the mock provider answers deterministic fixtures", async () => {
  const search = createSearch({ provider: createMockProvider() });
  const response = await search.web.search({ query: "sqlite", limit: 3 });
  expect(response.provider).toBe("mock");
  expect(response.results).toHaveLength(3);
  expect(response.results[0]?.url).toBe("https://example.com/search");
  expect(response.attempts).toHaveLength(1);
});

test("a transient failure moves to the fallback and says so", async () => {
  const primary = createMockProvider({ id: "primary", outcomes: [{ type: "error", code: "network" }] });
  const search = createSearch({ provider: primary, fallback: [createMockProvider({ id: "backup" })] });
  const response = await search.web.search({ query: "sqlite" });
  expect(response.provider).toBe("backup");
  expect(response.warnings).toContainEqual({ code: "fallback_used", provider: "backup" });
  expect(response.attempts).toHaveLength(2);
});

test("an auth failure never routes to the fallback", async () => {
  const primary = createMockProvider({ id: "primary", outcomes: [{ type: "error", code: "auth" }] });
  const backup = createMockProvider({ id: "backup" });
  const search = createSearch({ provider: primary, fallback: [backup] });
  const err = await search.web.search({ query: "sqlite" }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(SearchError);
  expect((err as SearchError).code).toBe("auth");
  expect(backup.calls).toHaveLength(0);
});

test("an empty result is a success, not a reason to move on", async () => {
  const primary = createMockProvider({ id: "primary", outcomes: [{ type: "success", results: [] }] });
  const backup = createMockProvider({ id: "backup" });
  const search = createSearch({ provider: primary, fallback: [backup] });
  const response = await search.web.search({ query: "sqlite" });
  expect(response.provider).toBe("primary");
  expect(response.results).toHaveLength(0);
  expect(backup.calls).toHaveLength(0);
});

test("a provider without domain support refuses filtered requests before dispatch", async () => {
  const plain = createMockProvider({ id: "plain" });
  const search = createSearch({
    provider: { ...plain, capabilities: { domainFilters: false, maxIncludeDomains: 0, maxExcludeDomains: 0 } },
  });
  const err = await search.web.search({ query: "sqlite", includeDomains: ["a.test"] }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(SearchError);
  expect((err as SearchError).code).toBe("unsupported_option");
  expect(plain.calls).toHaveLength(0);
});
