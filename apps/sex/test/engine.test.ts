import { expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { Engine } from "../src/engine.ts";
import { createLogger } from "../src/log.ts";

const base: Config = {
  host: "127.0.0.1",
  port: 0,
  logLevel: "error",
  allowPrivate: false,
  timeoutMs: 1_000,
  searchChain: [],
  searchExcluded: [],
  searchKeys: {},
};

const engine = (config: Partial<Config>): Engine => new Engine({ ...base, ...config }, createLogger("error"));

test("nothing configured is SearXNG alone", async () => {
  const e = engine({});
  expect(e.searchChain.ids).toEqual(["searxng"]);
  expect(e.describe().search).toBe("searxng");
  await e.close();
});

test("a configured chain gets SearXNG appended as the fallback", async () => {
  const e = engine({ searchChain: ["tavily"], searchKeys: { tavily: "k" } });
  expect(e.searchChain.ids).toEqual(["tavily", "searxng"]);
  expect(e.describe().search).toBe("tavily -> searxng");
  await e.close();
});

test("!searxng keeps the chain provider-only", async () => {
  const e = engine({ searchChain: ["tavily", "searxng"], searchExcluded: ["searxng"], searchKeys: { tavily: "k" } });
  expect(e.searchChain.ids).toEqual(["tavily"]);
  await e.close();
});

test("a provider without its key fails at startup", () => {
  expect(() => engine({ searchChain: ["tavily"] })).toThrow("SEX_SEARCH_TAVILY_KEY");
});

test("an unknown provider fails at startup naming the known ones", () => {
  expect(() => engine({ searchChain: ["quark"] })).toThrow('unknown search provider "quark"');
});

const searxngResult = {
  url: "https://a.test/",
  title: "Alpha",
  content: "from searxng",
  category: "general",
  engine: "x",
  engines: ["x"],
  positions: [1],
  score: 1,
  template: "default",
  parsed_url: null,
};

test("a configured provider answers through the whole stack", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).startsWith("https://api.tavily.com/"))
      return Response.json({ results: [{ url: "https://t.test/", title: "T", content: "stubbed" }] });
    throw new Error(`unexpected fetch: ${String(input)}`);
  }) as typeof fetch;
  try {
    const e = engine({ searchChain: ["tavily"], searchKeys: { tavily: "k" }, searxngUrl: "http://127.0.0.1:9" });
    const { data, provider, warning } = await e.search({ query: "hello" });
    expect(provider).toBe("tavily");
    expect(warning).toBeUndefined();
    expect(data.web?.[0]).toMatchObject({ url: "https://t.test/", description: "stubbed", position: 1 });
    await e.close();
  } finally {
    globalThis.fetch = original;
  }
});

test("when the provider falls over, SearXNG answers and the warning says so", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://api.tavily.com/")) return new Response("busy", { status: 429 });
    if (url.includes("/search")) return Response.json({ results: [searxngResult] });
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const e = engine({ searchChain: ["tavily"], searchKeys: { tavily: "k" }, searxngUrl: "http://127.0.0.1:8888" });
    const { data, provider, warning } = await e.search({ query: "hello" });
    expect(provider).toBe("searxng");
    expect(warning).toContain("tavily failed and the search moved to searxng");
    expect(data.web?.[0]).toMatchObject({ url: "https://a.test/", description: "from searxng" });
    await e.close();
  } finally {
    globalThis.fetch = original;
  }
});
