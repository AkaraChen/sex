import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

test("unconfigured search means SearXNG alone", () => {
  const config = loadConfig({});
  expect(config.searchChain).toEqual([]);
  expect(config.searchExcluded).toEqual([]);
  expect(config.searchKeys).toEqual({});
  expect(config.searchTimeoutMs).toBeUndefined();
});

test("the chain keeps order, collapses duplicates, and parses exclusions", () => {
  const config = loadConfig({ SEX_SEARCH_PROVIDER: "Tavily, brave ,!searxng, tavily" });
  expect(config.searchChain).toEqual(["tavily", "brave"]);
  expect(config.searchExcluded).toEqual(["searxng"]);
});

test("keys come from SEX_SEARCH_<ID>_KEY and blanks drop out", () => {
  const config = loadConfig({ SEX_SEARCH_TAVILY_KEY: "  k1 ", SEX_SEARCH_BRAVE_KEY: "", SEX_SEARCH_TIMEOUT: "4500" });
  expect(config.searchKeys).toEqual({ tavily: "k1" });
  expect(config.searchTimeoutMs).toBe(4500);
});

test("a lone bang is a config error", () => {
  expect(() => loadConfig({ SEX_SEARCH_PROVIDER: "tavily,!" })).toThrow("provider name");
});
