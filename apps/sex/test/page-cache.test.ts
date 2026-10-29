import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.ts";
import { Engine } from "../src/engine/engine.ts";
import { testEngine } from "./helpers.ts";

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
