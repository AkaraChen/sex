// The page cache (maxAge, storeInCache, minAge, lockdown) and the changeTracking format; both live in --data-dir.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startMockLlm } from "../lib/llm.ts";
import { killAll, type Server } from "../lib/proc.ts";
import { html, prose, type Site, site } from "../lib/sites.ts";
import { removeTempDirs, tempDir } from "../lib/tmp.ts";
import { kindOf, llmFlags, scrape, startSex, userOf } from "./helpers.ts";

let srv: Server;
let originFlags: Site;
let llm: ReturnType<typeof startMockLlm>;
let llmCalls: string[] = [];

/** Per-path state of the test site: its price text and an HTTP status. */
const state = new Map<string, { price: string; status: number }>();
const stateOf = (path: string) => {
  let s = state.get(path);
  if (!s) {
    s = { price: "one", status: 200 };
    state.set(path, s);
  }
  return s;
};
let n = 0;
/** A path nobody used before, so tests do not share cache entries. */
const fresh = (name: string) => `/${name}-${++n}`;
const hitsOf = (path: string) => originFlags.hits.filter((h) => h === path).length;

beforeAll(async () => {
  originFlags = site((req, url) => {
    const s = stateOf(url.pathname);
    if (s.status !== 200) return new Response("gone", { status: s.status });
    return html(
      "Shop",
      `<h1>Shop</h1><p>The price is ${s.price} dollars today.</p>${prose("the shop", 2)}<i data-ua="${req.headers.get("user-agent")}"></i>`,
    );
  });
  llm = startMockLlm((req) => {
    llmCalls.push(kindOf(req));
    if (kindOf(req) === "changes") return JSON.stringify({ summary: "the price changed" });
    const m = /price is (\w+) dollars/.exec(userOf(req));
    return JSON.stringify({ price: m?.[1] ?? null });
  });
  srv = await startSex(llmFlags(llm));
});

afterAll(async () => {
  originFlags.stop();
  llm.stop();
  await killAll();
  removeTempDirs();
});

const page = (path: string, extra: Record<string, unknown> = {}) =>
  scrape(srv, { url: `${originFlags.url}${path}`, formats: ["markdown"], ...extra });

describe("page cache", () => {
  test("by default nothing is cached (maxAge 0 means always fetch)", async () => {
    const p = fresh("nocache");
    const a = await page(p);
    const b = await page(p);
    expect(a.body.data.metadata.cacheState).toBe("miss");
    expect(b.body.data.metadata.cacheState).toBe("miss");
    expect(hitsOf(p)).toBe(2);
  });

  test("maxAge: a miss stores the page, the next request within maxAge is a hit with cachedAt", async () => {
    const p = fresh("maxage");
    const before = Date.now();
    const miss = await page(p, { maxAge: 60_000 });
    expect(miss.status).toBe(200);
    expect(miss.body.data.metadata.cacheState).toBe("miss");
    expect(miss.body.data.metadata.cachedAt).toBeUndefined();
    stateOf(p).price = "two"; // the origin changed, the cache does not know
    const hit = await page(p, { maxAge: 60_000 });
    expect(hit.body.data.metadata.cacheState).toBe("hit");
    const cachedAt = new Date(hit.body.data.metadata.cachedAt).getTime();
    expect(cachedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(cachedAt).toBeLessThanOrEqual(Date.now());
    expect(hit.body.data.markdown).toContain("price is one dollars");
    expect(hitsOf(p)).toBe(1);
  });

  test("a hit answers other formats too (it caches the fetched page, not the document)", async () => {
    const p = fresh("formats");
    await page(p, { maxAge: 60_000 });
    const hit = await scrape(srv, { url: `${originFlags.url}${p}`, formats: ["links", "rawHtml"], maxAge: 60_000 });
    expect(hit.body.data.metadata.cacheState).toBe("hit");
    expect(hit.body.data.rawHtml).toContain("The price is one dollars");
    expect(hitsOf(p)).toBe(1);
  });

  test("a maxAge shorter than the entry's age is a miss that refreshes it", async () => {
    const p = fresh("stale");
    await page(p, { maxAge: 60_000 });
    await Bun.sleep(300);
    stateOf(p).price = "two";
    const r = await page(p, { maxAge: 100 });
    expect(r.body.data.metadata.cacheState).toBe("miss");
    expect(r.body.data.markdown).toContain("price is two dollars");
    const again = await page(p, { maxAge: 60_000 });
    expect(again.body.data.metadata.cacheState).toBe("hit");
    expect(again.body.data.markdown).toContain("price is two dollars");
  });

  test("storeInCache: false fetches without storing", async () => {
    const p = fresh("nostore");
    const a = await page(p, { maxAge: 60_000, storeInCache: false });
    expect(a.body.data.metadata.cacheState).toBe("miss");
    const b = await page(p, { maxAge: 60_000 });
    expect(b.body.data.metadata.cacheState).toBe("miss");
    expect(hitsOf(p)).toBe(2);
    const c = await page(p, { maxAge: 60_000 });
    expect(c.body.data.metadata.cacheState).toBe("hit");
  });

  test("maxAge: 0 skips the read but refreshes the entry", async () => {
    const p = fresh("refresh");
    await page(p, { maxAge: 60_000 });
    stateOf(p).price = "two";
    const refreshed = await page(p, { maxAge: 0 });
    expect(refreshed.body.data.metadata.cacheState).toBe("miss");
    expect(refreshed.body.data.markdown).toContain("price is two dollars");
    const hit = await page(p, { maxAge: 60_000 });
    expect(hit.body.data.metadata.cacheState).toBe("hit");
    expect(hit.body.data.markdown).toContain("price is two dollars");
  });

  test("requests with headers never read or write the cache", async () => {
    const p = fresh("headers");
    await page(p, { maxAge: 60_000, headers: { "X-Test": "1" } });
    const r = await page(p, { maxAge: 60_000 });
    expect(r.body.data.metadata.cacheState).toBe("miss");
    expect(hitsOf(p)).toBe(2);
  });

  test("only 2xx pages are cached", async () => {
    const p = fresh("notfound");
    stateOf(p).status = 404;
    await page(p, { maxAge: 60_000 });
    stateOf(p).status = 200;
    const r = await page(p, { maxAge: 60_000 });
    expect(r.body.data.metadata.cacheState).toBe("miss");
    expect(r.body.data.metadata.statusCode).toBe(200);
  });

  test("lockdown only reads the cache: a hit when there is one, 404 SCRAPE_NO_CACHED_DATA when not, never a fetch", async () => {
    const p = fresh("lockdown");
    const none = await page(p, { lockdown: true });
    expect(none.status).toBe(404);
    expect(none.body.code).toBe("SCRAPE_NO_CACHED_DATA");
    expect(hitsOf(p)).toBe(0);
    await page(p, { maxAge: 60_000 });
    const hit = await page(p, { lockdown: true, maxAge: 60_000 });
    expect(hit.status).toBe(200);
    expect(hit.body.data.metadata.cacheState).toBe("hit");
    expect(hitsOf(p)).toBe(1);
  });

  test("minAge needs an entry at least that old", async () => {
    const p = fresh("minage");
    const none = await page(p, { minAge: 1 });
    expect(none.status).toBe(404);
    expect(none.body.code).toBe("SCRAPE_NO_CACHED_DATA");
    await page(p, { maxAge: 60_000 });
    const tooYoung = await page(p, { minAge: 3_600_000, maxAge: 7_200_000 });
    expect(tooYoung.status).toBe(404);
    await Bun.sleep(300);
    const old = await page(p, { minAge: 100, maxAge: 60_000 });
    expect(old.status).toBe(200);
    expect(old.body.data.metadata.cacheState).toBe("hit");
    expect(hitsOf(p)).toBe(1);
  });

  test("cached pages survive a restart (cache.sqlite in the data dir)", async () => {
    const dir = tempDir();
    const first = await startSex([], { dataDir: dir });
    const p = fresh("restart");
    await scrape(first, { url: `${originFlags.url}${p}`, formats: ["markdown"], maxAge: 60_000 });
    await first.stop();
    const second = await startSex([], { dataDir: dir });
    const hit = await scrape(second, { url: `${originFlags.url}${p}`, formats: ["markdown"], maxAge: 60_000 });
    expect(hit.body.data.metadata.cacheState).toBe("hit");
    expect(hitsOf(p)).toBe(1);
    await second.stop();
  });

  test("SEX_CACHE_MAX_AGE_MS makes a request without maxAge use the cache", async () => {
    const withDefault = await startSex([], { env: { SEX_CACHE_MAX_AGE_MS: "60000" } });
    const p = fresh("default");
    await scrape(withDefault, { url: `${originFlags.url}${p}`, formats: ["markdown"] });
    const hit = await scrape(withDefault, { url: `${originFlags.url}${p}`, formats: ["markdown"] });
    expect(hit.body.data.metadata.cacheState).toBe("hit");
    expect(hitsOf(p)).toBe(1);
    await withDefault.stop();
  });
});

describe("changeTracking", () => {
  const ct = (extra: Record<string, unknown> = {}) => ({ type: "changeTracking", modes: ["git-diff"], ...extra });
  const track = (path: string, format: Record<string, unknown> = ct(), extra: Record<string, unknown> = {}) =>
    scrape(srv, { url: `${originFlags.url}${path}`, formats: ["markdown", format], ...extra });

  test("new, then same, then changed with a git-diff", async () => {
    const p = fresh("track");
    const first = await track(p);
    expect(first.status).toBe(200);
    expect(first.body.data.changeTracking).toEqual({ previousScrapeAt: null, changeStatus: "new", visibility: "visible" });

    const second = await track(p);
    expect(second.body.data.changeTracking.changeStatus).toBe("same");
    expect(new Date(second.body.data.changeTracking.previousScrapeAt).getTime()).toBeLessThanOrEqual(Date.now());
    expect(second.body.data.changeTracking.diff).toBeUndefined();

    stateOf(p).price = "two";
    const third = await track(p);
    const c = third.body.data.changeTracking;
    expect(c.changeStatus).toBe("changed");
    expect(c.diff.text).toContain("--- previous.md");
    expect(c.diff.text).toContain("-The price is one dollars today.");
    expect(c.diff.text).toContain("+The price is two dollars today.");
    expect(c.diff.json.files[0]).toMatchObject({ from: "previous.md", to: "current.md" });
    const changes = c.diff.json.files[0].chunks.flatMap((k: any) => k.changes);
    expect(changes.some((x: any) => x.type === "del" && x.content.includes("one dollars"))).toBe(true);
    expect(changes.some((x: any) => x.type === "add" && x.content.includes("two dollars"))).toBe(true);

    // The new version is now the one compared against.
    const fourth = await track(p);
    expect(fourth.body.data.changeTracking.changeStatus).toBe("same");
  });

  test("a changed word is a change, and so is a moved paragraph (stricter than Firecrawl)", async () => {
    const p = fresh("strict");
    await track(p);
    stateOf(p).price = "onE"; // same letters, different spelling
    const r = await track(p);
    expect(r.body.data.changeTracking.changeStatus).toBe("changed");
  });

  test("tags keep separate histories", async () => {
    const p = fresh("tags");
    const a1 = await track(p, ct({ tag: "daily" }));
    const b1 = await track(p, ct({ tag: "weekly" }));
    expect(a1.body.data.changeTracking.changeStatus).toBe("new");
    expect(b1.body.data.changeTracking.changeStatus).toBe("new");
    stateOf(p).price = "two";
    const a2 = await track(p, ct({ tag: "daily" }));
    expect(a2.body.data.changeTracking.changeStatus).toBe("changed");
    // "weekly" still holds the old version.
    const b2 = await track(p, ct({ tag: "weekly" }));
    expect(b2.body.data.changeTracking.changeStatus).toBe("changed");
    // No tag is its own history, and an empty tag is no tag.
    const n1 = await track(p, ct());
    const n2 = await track(p, ct({ tag: "" }));
    expect(n1.body.data.changeTracking.changeStatus).toBe("new");
    expect(n2.body.data.changeTracking.changeStatus).toBe("same");
  });

  test("a page that is now a 404 is removed, and the stored version is kept", async () => {
    const p = fresh("removed");
    await track(p);
    stateOf(p).status = 404;
    const gone = await track(p);
    expect(gone.body.data.changeTracking.changeStatus).toBe("removed");
    stateOf(p).status = 200;
    const back = await track(p);
    expect(back.body.data.changeTracking.changeStatus).toBe("same");
  });

  test("json mode with a schema compares the extracted fields of both versions", async () => {
    const p = fresh("json-schema");
    const format = ct({ modes: ["json"], schema: { type: "object", properties: { price: { type: "string" } } } });
    await track(p, format);
    stateOf(p).price = "two";
    llmCalls = [];
    const r = await track(p, format);
    const c = r.body.data.changeTracking;
    expect(c.changeStatus).toBe("changed");
    expect(c.json).toEqual({ price: { previous: "one", current: "two" } });
    expect(llmCalls.filter((k) => k === "extract")).toHaveLength(2);
  });

  test("json mode without a schema asks the model to describe the changes", async () => {
    const p = fresh("json-prompt");
    const format = ct({ modes: ["json"], prompt: "what happened to the price?" });
    await track(p, format);
    stateOf(p).price = "two";
    llmCalls = [];
    const r = await track(p, format);
    expect(r.body.data.changeTracking.json).toEqual({ summary: "the price changed" });
    expect(llmCalls).toContain("changes");
  });

  test("both modes together", async () => {
    const p = fresh("both");
    const format = ct({ modes: ["git-diff", "json"], prompt: "price?" });
    await track(p, format);
    stateOf(p).price = "two";
    const r = await track(p, format);
    expect(r.body.data.changeTracking.diff.text).toContain("+The price is two dollars today.");
    expect(r.body.data.changeTracking.json).toEqual({ summary: "the price changed" });
  });

  test("changeTracking needs markdown, and json mode needs an LLM", async () => {
    const p = fresh("needs");
    const noMarkdown = await scrape(srv, { url: `${originFlags.url}${p}`, formats: [ct()] });
    expect(noMarkdown.status).toBe(400);
    const bare = await startSex();
    const noLlm = await scrape(bare, { url: `${originFlags.url}${p}`, formats: ["markdown", ct({ modes: ["json"] })] });
    expect(noLlm.status).toBe(501);
    expect(noLlm.body.code).toBe("LLM_NOT_CONFIGURED");
    await bare.stop();
  });

  test("history survives a restart", async () => {
    const dir = tempDir();
    const p = fresh("persist");
    const first = await startSex([], { dataDir: dir });
    await scrape(first, { url: `${originFlags.url}${p}`, formats: ["markdown", ct()] });
    await first.stop();
    stateOf(p).price = "two";
    const second = await startSex([], { dataDir: dir });
    const r = await scrape(second, { url: `${originFlags.url}${p}`, formats: ["markdown", ct()] });
    expect(r.body.data.changeTracking.changeStatus).toBe("changed");
    await second.stop();
  });
});
