import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { after, describe, test } from "node:test";
import { normalizeDomain, search } from "@searxng-js/sex-search";
import { json, searchContext, serve } from "./support.ts";

const hit = { results: [{ url: "https://example.test/a", title: "A", content: "a" }] };

/** The rejection of a promise, or null. */
const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e,
  );
const code = (err: unknown) => (err as { code?: string } | null)?.code;

describe("SearXNG robustness", async () => {
  let calls = 0;
  const queries: string[] = [];
  let handler: (call: number, res: ServerResponse) => void = (_, res) => json(res, { results: [] });
  const searx = await serve((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.searchParams.get("pageno") !== "1") return json(res, { results: [] });
    queries.push(u.searchParams.get("q") ?? "");
    handler(++calls, res);
  });
  const ctx = searchContext(searx.url);
  after(async () => {
    await ctx.close();
    await searx.close();
  });
  const reset = (h: typeof handler) => {
    calls = 0;
    queries.length = 0;
    handler = h;
  };

  test("a 5xx is retried once", async () => {
    reset((call, res) => (call === 1 ? json(res, "boom", 503) : json(res, hit)));
    const { data } = await search(ctx, { query: "x" });
    assert.equal(data.web?.[0]?.url, "https://example.test/a");
    assert.equal(calls, 2);
  });

  test("a persistent 5xx fails after one retry", async () => {
    reset((_, res) => json(res, "boom", 500));
    assert.equal(code(await caught(search(ctx, { query: "x" }))), "SEARCH_BACKEND_ERROR");
    assert.equal(calls, 2);
  });

  test("a 4xx is not retried", async () => {
    reset((_, res) => json(res, "no", 403));
    assert.equal(code(await caught(search(ctx, { query: "x" }))), "SEARCH_BACKEND_ERROR");
    assert.equal(calls, 1);
  });

  test("a retry does not outlive the request timeout", async () => {
    reset((_, res) => json(res, "boom", 500));
    const started = Date.now();
    const err = await caught(search(ctx, { query: "x", timeout: 100 }));
    assert.equal(code(err), "TIMEOUT");
    assert.ok(Date.now() - started < 2000);
  });

  test("a cancelled search is a TIMEOUT that says so", async () => {
    reset((_, res) => setTimeout(() => json(res, hit), 2_000));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const err = await caught(search(ctx, { query: "x" }, controller.signal));
    assert.equal(code(err), "TIMEOUT");
    assert.match((err as Error).message, /^Request cancelled/);
  });

  test("a search that runs out of time says how long it had", async () => {
    reset((_, res) => setTimeout(() => json(res, hit), 3_000));
    const err = await caught(search(ctx, { query: "x", timeout: 1000 }));
    assert.equal(code(err), "TIMEOUT");
    assert.match((err as Error).message, /^Timed out after 1000ms while querying SearXNG/);
  });

  test("empty results name the unresponsive engines in the warning", async () => {
    reset((_, res) => json(res, { results: [], unresponsive_engines: [["google", "CAPTCHA"]] }));
    const { data, warning } = await search(ctx, { query: "x" });
    assert.deepEqual(data.web, []);
    assert.ok(warning?.includes("google: CAPTCHA"));
  });

  test("includeDomains are trimmed and lowercased before they reach the query", async () => {
    reset((_, res) => json(res, hit));
    await search(ctx, { query: "x", includeDomains: ["  Example.TEST "] });
    assert.deepEqual(queries, ["x site:example.test"]);
  });

  test("an invalid includeDomains entry is a 400", async () => {
    assert.equal(code(await caught(search(ctx, { query: "x", includeDomains: ["a b.com"] }))), "BAD_REQUEST");
    assert.throws(() => normalizeDomain("http://example.com"));
    assert.equal(normalizeDomain("*.Example.com"), "example.com");
  });
});

describe("search v2 parameters", async () => {
  const seen: URL[] = [];
  const wide = await serve((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    seen.push(u);
    if (u.searchParams.get("pageno") !== "1") return json(res, { results: [] });
    json(res, {
      results: [
        { url: "https://github.com/a/b", title: "gh", content: "" },
        { url: "https://example.org/paper.pdf", title: "pdf", content: "" },
        { url: "https://arxiv.example/x", title: "sci", content: "", category: "science" },
        { url: "https://other.test/", title: "plain", content: "" },
      ],
    });
  });
  const ctx = searchContext(wide.url);
  after(async () => {
    await ctx.close();
    await wide.close();
  });

  test("safe sets safesearch=2, and is absent otherwise", async () => {
    seen.length = 0;
    await search(ctx, { query: "x", safe: true });
    await search(ctx, { query: "x" });
    const first = seen.filter((u) => u.searchParams.get("pageno") === "1");
    assert.equal(first[0]?.searchParams.get("safesearch"), "2");
    assert.equal(first[1]?.searchParams.has("safesearch"), false);
  });

  test("results are tagged with a category", async () => {
    const { data } = await search(ctx, { query: "x", limit: 10 });
    assert.deepEqual(
      data.web?.map((r) => r.category),
      ["github", "pdf", "research", undefined],
    );
  });

  test("unsupported parameters are named in the warning", async () => {
    const { warning } = await search(ctx, { query: "x", tbs: "sbd:1", country: "DE", location: "Berlin" });
    for (const name of ["tbs", "country", "location"]) assert.ok(warning?.includes(name));
    assert.equal((await search(ctx, { query: "x", tbs: "qdr:w" })).warning, undefined);
  });

  test("site: filters the results", async () => {
    const { data } = await search(ctx, { query: "site:github.com x" });
    assert.deepEqual(
      data.web?.map((r) => r.url),
      ["https://github.com/a/b"],
    );
  });
});

describe("a SearXNG that is still starting", () => {
  /** A context whose SearXNG takes `ms` to report its URL, like a managed one on its first start. */
  const slowStart = (ms: number) => {
    const ctx = searchContext("http://127.0.0.1:9");
    return { ...ctx, searxng: { url: () => new Promise<string>((resolve) => setTimeout(() => resolve("http://127.0.0.1:9"), ms)) } };
  };

  test("a cancel ends the wait at once with TIMEOUT", async () => {
    const ctx = slowStart(5_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const err = await caught(search(ctx, { query: "x" }, controller.signal));
    assert.equal(code(err), "TIMEOUT");
    assert.match(String((err as Error).message), /cancelled while waiting for SearXNG to start/);
    assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
    await ctx.close();
  });

  test("the request's timeout ends the wait", async () => {
    const ctx = slowStart(5_000);
    const started = Date.now();
    const err = await caught(search(ctx, { query: "x", timeout: 500 }));
    assert.equal(code(err), "TIMEOUT");
    assert.match(String((err as Error).message), /Timed out after 500ms while waiting for SearXNG to start/);
    assert.ok(Date.now() - started < 2_500, `took ${Date.now() - started} ms`);
    await ctx.close();
  });
});
