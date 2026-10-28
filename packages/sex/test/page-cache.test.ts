import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.ts";
import { SqliteScrapeCache } from "../src/engine/cache.ts";
import { Engine } from "../src/engine/engine.ts";
import { testEngine } from "./helpers.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const page = (body: string) => ({
  url: "https://example.test/final",
  status: 200,
  contentType: "text/html; charset=utf-8",
  body: enc(body),
});
const key = (url: string, variant = "http") => ({ url, variant });

describe("SqliteScrapeCache", () => {
  let dir: string;
  let clock: number;
  const open = (opts: Partial<ConstructorParameters<typeof SqliteScrapeCache>[1]> = {}, file = "cache.sqlite") =>
    new SqliteScrapeCache(join(dir, file), { defaultMaxAge: 0, ttlMs: 100_000, maxBytes: 10 * 1024 * 1024, now: () => clock, ...opts });
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sex-cache-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("stores and returns a page between minAge and maxAge", async () => {
    clock = 1_000_000;
    const cache = open({}, "ages.sqlite");
    await cache.put(key("https://a.test/"), page("hello"));
    clock += 10_000;
    const hit = await cache.get(key("https://a.test/"), { maxAge: 20_000 });
    expect(hit && { ...hit, body: dec(hit.body) }).toEqual({ ...page("hello"), body: "hello", storedAt: 1_000_000 });
    expect(await cache.get(key("https://a.test/"), { maxAge: 5_000 })).toBeUndefined();
    expect(await cache.get(key("https://a.test/"), { minAge: 10_001, maxAge: 20_000 })).toBeUndefined();
    expect(await cache.get(key("https://a.test/"), { minAge: 10_000, maxAge: 20_000 })).toBeDefined();
    expect(await cache.get(key("https://a.test/", "mobile"), { maxAge: 20_000 })).toBeUndefined();
    cache.close();
  });

  test("a second put replaces the entry", async () => {
    clock = 1_000_000;
    const cache = open({}, "replace.sqlite");
    await cache.put(key("https://a.test/"), page("one"));
    clock += 1000;
    await cache.put(key("https://a.test/"), page("two"));
    const hit = await cache.get(key("https://a.test/"), { maxAge: 10_000 });
    expect([dec(hit?.body ?? new Uint8Array()), hit?.storedAt]).toEqual(["two", 1_001_000]);
    cache.close();
  });

  test("entries survive a reopen, and the ones past the ttl are deleted on open", async () => {
    clock = 1_000_000;
    const first = open({}, "reopen.sqlite");
    await first.put(key("https://old.test/"), page("old"));
    clock += 60_000;
    await first.put(key("https://new.test/"), page("new"));
    first.close();
    clock += 50_000;
    const second = open({}, "reopen.sqlite");
    expect(await second.get(key("https://old.test/"), { maxAge: 1_000_000 })).toBeUndefined();
    expect(dec((await second.get(key("https://new.test/"), { maxAge: 1_000_000 }))?.body ?? new Uint8Array())).toBe("new");
    second.close();
  });

  test("the size limit evicts the least recently used entries", async () => {
    clock = 1_000_000;
    // Incompressible bodies, so the stored size is about the body size.
    const body = (n: number) => crypto.getRandomValues(new Uint8Array(n));
    const cache = open({ maxBytes: 16_000 }, "lru.sqlite");
    for (const name of ["a", "b", "c"]) {
      clock += 10;
      await cache.put(key(`https://${name}.test/`), { ...page(""), body: body(1_900) });
    }
    clock += 10;
    expect(await cache.get(key("https://a.test/"), { maxAge: 1_000_000 })).toBeDefined(); // a is now the most recently used
    for (const name of ["d", "e", "f", "g", "h", "i"]) {
      clock += 10;
      await cache.put(key(`https://${name}.test/`), { ...page(""), body: body(1_900) });
    }
    const present = async (name: string) => !!(await cache.get(key(`https://${name}.test/`), { maxAge: 1_000_000 }));
    // 9 entries of ~1.9 KB do not fit in 16 KB; the oldest unused one is gone, the touched one stays.
    expect(await present("b")).toBe(false);
    expect(await present("a")).toBe(true);
    expect(await present("i")).toBe(true);
    cache.close();
  });

  test("a page above an eighth of the limit is not stored", async () => {
    const cache = open({ maxBytes: 16_000 }, "big.sqlite");
    await cache.put(key("https://big.test/"), { ...page(""), body: crypto.getRandomValues(new Uint8Array(2_100)) });
    expect(await cache.get(key("https://big.test/"), { maxAge: 1_000_000 })).toBeUndefined();
    cache.close();
  });

  test("a file that is not a database is replaced", async () => {
    clock = 1_000_000;
    await Bun.write(join(dir, "broken.sqlite"), "this is not a database, but it is long enough to be taken for one by sqlite".repeat(100));
    const cache = open({}, "broken.sqlite");
    expect(await cache.get(key("https://a.test/"), { maxAge: 1000 })).toBeUndefined();
    await cache.put(key("https://a.test/"), page("x"));
    expect(await cache.get(key("https://a.test/"), { maxAge: 1000 })).toBeDefined();
    cache.close();
  });
});

describe("cache in the engine", () => {
  let dir: string;
  let hits = 0;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sex-cache-engine-"));
    server = Bun.serve({
      port: 0,
      fetch() {
        hits++;
        return new Response(
          `<html><head><title>T</title></head><body><main><h1>T</h1>${"<p>Words, plenty of them. </p>".repeat(8)}</main></body></html>`,
          {
            headers: { "content-type": "text/html" },
          },
        );
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("with a data dir, maxAge serves repeats from cache.sqlite and a restart keeps them", async () => {
    hits = 0;
    const first = testEngine({ dataDir: dir });
    expect((await first.scrape({ url: `${base}/p`, maxAge: 60_000 })).metadata?.cacheState).toBe("miss");
    expect((await first.scrape({ url: `${base}/p`, maxAge: 60_000 })).metadata?.cacheState).toBe("hit");
    await first.close();
    const second = testEngine({ dataDir: dir });
    const doc = await second.scrape({ url: `${base}/p`, lockdown: true });
    expect(doc.metadata?.cacheState).toBe("hit");
    expect(hits).toBe(1);
    await second.close();
  });

  test("SEX_CACHE_MAX_AGE_MS makes it the default", async () => {
    hits = 0;
    const config = resolveConfig({ dataDir: join(dir, "default") }, { allowPrivateNetwork: true }, { SEX_CACHE_MAX_AGE_MS: "60000" });
    expect(config.cacheMaxAgeMs).toBe(60_000);
    const engine = new Engine({ ...config, searxngUrl: "http://127.0.0.1:1" });
    expect(engine.cache?.defaultMaxAge).toBe(60_000);
    await engine.scrape({ url: `${base}/d` });
    expect((await engine.scrape({ url: `${base}/d` })).metadata?.cacheState).toBe("hit");
    expect(hits).toBe(1);
    await engine.close();
  });

  test("without a data dir there is no cache: maxAge is ignored, lockdown is 404", async () => {
    hits = 0;
    const engine = testEngine();
    expect(engine.cache).toBeUndefined();
    await engine.scrape({ url: `${base}/q`, maxAge: 60_000 });
    await engine.scrape({ url: `${base}/q`, maxAge: 60_000 });
    expect(hits).toBe(2);
    expect(engine.scrape({ url: `${base}/q`, lockdown: true })).rejects.toMatchObject({ code: "SCRAPE_NO_CACHED_DATA" });
    await engine.close();
  });

  test("the settings are checked", () => {
    const resolve = (env: Record<string, string>) => () => resolveConfig({}, { allowPrivateNetwork: false }, env);
    expect(resolve({ SEX_CACHE_TTL_MS: "10" })).toThrow("SEX_CACHE_TTL_MS");
    expect(resolve({ SEX_CACHE_MAX_BYTES: "10" })).toThrow("SEX_CACHE_MAX_BYTES");
    expect(resolve({ SEX_CACHE_MAX_AGE_MS: "-1" })).toThrow("SEX_CACHE_MAX_AGE_MS");
    expect(resolveConfig({}, { allowPrivateNetwork: false }, {})).toMatchObject({
      cacheMaxAgeMs: 0,
      cacheTtlMs: 172_800_000,
      cacheMaxBytes: 256 * 1024 * 1024,
    });
  });
});
