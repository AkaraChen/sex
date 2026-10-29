import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { SqliteScrapeCache } from "@searxng-js/sex-store";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const page = (body: string | Uint8Array) => ({
  url: "https://example.test/final",
  status: 200,
  contentType: "text/html; charset=utf-8",
  body: typeof body === "string" ? enc(body) : body,
});
const key = (url: string, variant = "http") => ({ url, variant });

describe("SqliteScrapeCache", () => {
  let dir: string;
  let clock: number;
  const open = (opts: Partial<ConstructorParameters<typeof SqliteScrapeCache>[1]> = {}, file = "cache.sqlite") =>
    new SqliteScrapeCache(join(dir, file), { defaultMaxAge: 0, ttlMs: 100_000, maxBytes: 10 * 1024 * 1024, now: () => clock, ...opts });
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "sex-cache-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("stores and returns a page between minAge and maxAge", async () => {
    clock = 1_000_000;
    const cache = open({}, "ages.sqlite");
    await cache.put(key("https://a.test/"), page("hello"));
    clock += 10_000;
    const hit = await cache.get(key("https://a.test/"), { maxAge: 20_000 });
    assert.deepEqual(hit && { ...hit, body: dec(hit.body) }, { ...page("hello"), body: "hello", storedAt: 1_000_000 });
    assert.equal(await cache.get(key("https://a.test/"), { maxAge: 5_000 }), undefined);
    assert.equal(await cache.get(key("https://a.test/"), { minAge: 10_001, maxAge: 20_000 }), undefined);
    assert.notEqual(await cache.get(key("https://a.test/"), { minAge: 10_000, maxAge: 20_000 }), undefined);
    assert.equal(await cache.get(key("https://a.test/", "mobile"), { maxAge: 20_000 }), undefined);
    cache.close();
  });

  test("a second put replaces the entry", async () => {
    clock = 1_000_000;
    const cache = open({}, "replace.sqlite");
    await cache.put(key("https://a.test/"), page("one"));
    clock += 1000;
    await cache.put(key("https://a.test/"), page("two"));
    const hit = await cache.get(key("https://a.test/"), { maxAge: 10_000 });
    assert.deepEqual([dec(hit?.body ?? new Uint8Array()), hit?.storedAt], ["two", 1_001_000]);
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
    assert.equal(await second.get(key("https://old.test/"), { maxAge: 1_000_000 }), undefined);
    assert.equal(dec((await second.get(key("https://new.test/"), { maxAge: 1_000_000 }))?.body ?? new Uint8Array()), "new");
    second.close();
  });

  test("the size limit evicts the least recently used entries", async () => {
    clock = 1_000_000;
    // Incompressible bodies, so the stored size is about the body size.
    const cache = open({ maxBytes: 16_000 }, "lru.sqlite");
    for (const name of ["a", "b", "c"]) {
      clock += 10;
      await cache.put(key(`https://${name}.test/`), page(randomBytes(1_900)));
    }
    clock += 10;
    assert.ok(await cache.get(key("https://a.test/"), { maxAge: 1_000_000 })); // a is now the most recently used
    for (const name of ["d", "e", "f", "g", "h", "i"]) {
      clock += 10;
      await cache.put(key(`https://${name}.test/`), page(randomBytes(1_900)));
    }
    const present = async (name: string) => !!(await cache.get(key(`https://${name}.test/`), { maxAge: 1_000_000 }));
    // 9 entries of ~1.9 KB do not fit in 16 KB; the oldest unused one is gone, the touched one stays.
    assert.equal(await present("b"), false);
    assert.equal(await present("a"), true);
    assert.equal(await present("i"), true);
    cache.close();
  });

  test("a page above an eighth of the limit is not stored", async () => {
    const cache = open({ maxBytes: 16_000 }, "big.sqlite");
    await cache.put(key("https://big.test/"), page(randomBytes(2_100)));
    assert.equal(await cache.get(key("https://big.test/"), { maxAge: 1_000_000 }), undefined);
    cache.close();
  });

  test("a file that is not a database is replaced, and the logger hears of it", async () => {
    clock = 1_000_000;
    writeFileSync(join(dir, "broken.sqlite"), "this is not a database, but it is long enough to be taken for one by sqlite".repeat(100));
    const warnings: string[] = [];
    const cache = open({ logger: { debug() {}, info() {}, error() {}, warn: (m) => warnings.push(m) } }, "broken.sqlite");
    assert.equal(await cache.get(key("https://a.test/"), { maxAge: 1000 }), undefined);
    await cache.put(key("https://a.test/"), page("x"));
    assert.ok(await cache.get(key("https://a.test/"), { maxAge: 1000 }));
    assert.deepEqual(warnings, ["page cache file is unusable and is recreated"]);
    cache.close();
  });

  test("opens a cache.sqlite written by the Bun-only version (same schema, user_version 1, zstd bodies)", async () => {
    clock = 1_000_000;
    const file = join(dir, "legacy.sqlite");
    const old = new DatabaseSync(file);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(`CREATE TABLE page_cache (
        url TEXT NOT NULL,
        variant TEXT NOT NULL,
        stored_at INTEGER NOT NULL,
        used_at INTEGER NOT NULL,
        final_url TEXT NOT NULL,
        status INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        body BLOB NOT NULL,
        PRIMARY KEY (url, variant)
      )`);
    old.exec("CREATE INDEX page_cache_stored ON page_cache (stored_at)");
    old.exec("CREATE INDEX page_cache_used ON page_cache (used_at)");
    old.exec("PRAGMA user_version = 1");
    const body = zstdCompressSync(enc("from the old version"));
    old
      .prepare("INSERT INTO page_cache VALUES ('https://a.test/', 'http', ?, ?, 'https://a.test/x', 200, 'text/html', ?, ?)")
      .run(clock - 500, clock - 500, body.length, body);
    old.close();
    const cache = open({}, "legacy.sqlite");
    const hit = await cache.get(key("https://a.test/"), { maxAge: 10_000 });
    assert.equal(hit && dec(hit.body), "from the old version");
    assert.equal(hit?.url, "https://a.test/x");
    cache.close();
  });
});
