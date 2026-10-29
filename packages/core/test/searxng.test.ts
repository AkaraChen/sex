import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppError } from "@searxng-js/sex-errors";
import { testCoreEngine, waitFor } from "./helpers.ts";

const fake = join(import.meta.dir, "fixtures", "fake-searxng.ts");
const dir = mkdtempSync(join(tmpdir(), "sex-searxng-"));
const okSettings = join(dir, "ok.yml");
const crashSettings = join(dir, "crash.yml");
writeFileSync(okSettings, "use_default_settings: true\n");
writeFileSync(crashSettings, "fake: crash\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const managedEngine = (settings: string, extra: { searxngPath?: string } = {}) =>
  testCoreEngine({ searxngUrl: "", searxngPath: fake, searxngSettings: settings, ...extra });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("managed SearXNG", () => {
  test("starts on first search, once for concurrent callers, and stops on close", async () => {
    const engine = managedEngine(okSettings);
    expect(engine.searxng.managed).toBe(true);
    expect(engine.searxng.pid).toBeUndefined();
    const [a, b] = await Promise.all([engine.searxng.url(), engine.searxng.url()]);
    expect(a).toBe(b);
    const { data } = await engine.search({ query: "zig", limit: 5 } as never);
    expect(data.web?.[0]?.title).toBe("fake: zig");
    expect(engine.describe().searxng).toContain(`pid ${engine.searxng.pid}`);
    const pid = engine.searxng.pid as number;
    await engine.close();
    expect(alive(pid)).toBe(false);
  });

  test("is started again after it exits", async () => {
    const engine = managedEngine(okSettings);
    try {
      await engine.searxng.warmup();
      const first = engine.searxng.pid as number;
      process.kill(first, "SIGKILL");
      await waitFor(() => (engine.searxng.pid === undefined ? true : undefined));
      await engine.searxng.url();
      expect(engine.searxng.pid).toBeDefined();
      expect(engine.searxng.pid).not.toBe(first);
    } finally {
      await engine.close();
    }
  });

  test("a failed start is a 502 with the server output, and repeated failures pause restarts", async () => {
    const engine = managedEngine(crashSettings);
    try {
      const fail = () =>
        engine.searxng.url().then(
          () => undefined,
          (err: unknown) => err as AppError,
        );
      const first = await fail();
      expect(first?.status).toBe(502);
      expect(first?.code).toBe("SEARCH_BACKEND_UNAVAILABLE");
      expect(first?.message).toContain("fake: boom");
      expect(first?.message).toContain("SEX_SEARXNG_URL");
      await fail();
      await fail();
      const paused = await fail();
      expect(paused?.message).toContain("Not starting SearXNG");
    } finally {
      await engine.close();
    }
  });

  test("a missing binary is a 502", async () => {
    const engine = managedEngine(okSettings, { searxngPath: join(dir, "nope") });
    try {
      const err = (await engine.searxng.url().catch((e: unknown) => e)) as AppError;
      expect(err.code).toBe("SEARCH_BACKEND_UNAVAILABLE");
    } finally {
      await engine.close();
    }
  });

  test("an external SEX_SEARXNG_URL starts nothing", async () => {
    const engine = testCoreEngine({ searxngUrl: "http://127.0.0.1:1/", searxngPath: fake });
    expect(engine.searxng.managed).toBe(false);
    expect(await engine.searxng.url()).toBe("http://127.0.0.1:1");
    await engine.searxng.warmup();
    expect(engine.searxng.pid).toBeUndefined();
    await engine.close();
  });
});

// Opt-in: the real bundled binary (or SEX_TEST_SEARXNG_PATH), with the default settings.
describe.skipIf(!process.env.SEX_TEST_SEARXNG)("real SearXNG", () => {
  test("starts and answers the JSON API", async () => {
    const engine = testCoreEngine({ searxngUrl: "", searxngPath: process.env.SEX_TEST_SEARXNG_PATH });
    try {
      const url = await engine.searxng.url();
      const res = await fetch(`${url}/search?q=wikipedia&format=json&engines=wikipedia`);
      expect(res.status).toBe(200);
      expect(Array.isArray(((await res.json()) as { results: unknown[] }).results)).toBe(true);
    } finally {
      await engine.close();
    }
  }, 90_000);
});
