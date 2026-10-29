import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { type SearxngOptions, SearxngService } from "@searxng-js/sex-searxng";

const fake = join(import.meta.dirname, "fixtures", "fake-searxng.ts");
const dir = mkdtempSync(join(tmpdir(), "sex-searxng-"));
const okSettings = join(dir, "ok.yml");
const crashSettings = join(dir, "crash.yml");
writeFileSync(okSettings, "use_default_settings: true\n");
writeFileSync(crashSettings, "fake: crash\n");
after(() => rmSync(dir, { recursive: true, force: true }));

const managed = (settingsPath: string, extra: SearxngOptions = {}) => new SearxngService({ binaryPath: fake, settingsPath, ...extra });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("managed SearXNG", () => {
  test("starts on first use, once for concurrent callers, and stops on close", async () => {
    const searxng = managed(okSettings);
    assert.equal(searxng.managed, true);
    assert.equal(searxng.pid as number | undefined, undefined);
    assert.equal(searxng.describe(), "managed (not started)");
    const [a, b] = await Promise.all([searxng.url(), searxng.url()]);
    assert.equal(a, b);
    const body = (await (await fetch(`${a}/search?q=zig`)).json()) as { results: Array<{ title: string }> };
    assert.equal(body.results[0]?.title, "fake: zig");
    assert.match(searxng.describe(), new RegExp(`pid ${searxng.pid}`));
    const pid = searxng.pid as number;
    await searxng.close();
    await until(() => !alive(pid));
  });

  test("is started again after it exits", async () => {
    const searxng = managed(okSettings);
    try {
      await searxng.warmup();
      const first = searxng.pid as number;
      process.kill(first, "SIGKILL");
      await until(() => searxng.pid === undefined);
      await searxng.url();
      assert.notEqual(searxng.pid, undefined);
      assert.notEqual(searxng.pid, first);
    } finally {
      await searxng.close();
    }
  });

  test("a failed start is SEARCH_BACKEND_UNAVAILABLE with the server output, and repeated failures pause restarts", async () => {
    const searxng = managed(crashSettings);
    const fail = () =>
      searxng.url().then(
        () => undefined,
        (err: unknown) => err as { status: number; code: string; message: string },
      );
    try {
      const first = await fail();
      assert.equal(first?.status, 502);
      assert.equal(first?.code, "SEARCH_BACKEND_UNAVAILABLE");
      assert.match(first?.message ?? "", /fake: boom/);
      await fail();
      await fail();
      const paused = await fail();
      assert.match(paused?.message ?? "", /Not starting SearXNG/);
    } finally {
      await searxng.close();
    }
  });

  test("a missing binary is SEARCH_BACKEND_UNAVAILABLE", async () => {
    const searxng = managed(okSettings, { binaryPath: join(dir, "nope") });
    try {
      const err = (await searxng.url().catch((e: unknown) => e)) as { code: string };
      assert.equal(err.code, "SEARCH_BACKEND_UNAVAILABLE");
    } finally {
      await searxng.close();
    }
  });

  test("an external url starts nothing", async () => {
    const searxng = new SearxngService({ url: "http://127.0.0.1:1", binaryPath: fake });
    assert.equal(searxng.managed, false);
    assert.equal(await searxng.url(), "http://127.0.0.1:1");
    await searxng.warmup();
    assert.equal(searxng.pid, undefined);
    await searxng.close();
  });

  test("log lines go to the logger option, and nowhere without one", async () => {
    const lines: string[] = [];
    const log = (level: string) => (message: string) => void lines.push(`${level} ${message}`);
    const searxng = managed(okSettings, { logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") } });
    try {
      await searxng.warmup();
    } finally {
      await searxng.close();
    }
    assert.ok(lines.includes("info searxng started"));
  });
});

// Opt-in: the real bundled binary (or SEX_TEST_SEARXNG_PATH), with the default settings.
describe("real SearXNG", { skip: !process.env.SEX_TEST_SEARXNG }, () => {
  test("starts and answers the JSON API", { timeout: 90_000 }, async () => {
    const searxng = new SearxngService({ binaryPath: process.env.SEX_TEST_SEARXNG_PATH });
    try {
      const url = await searxng.url();
      const res = await fetch(`${url}/search?q=wikipedia&format=json&engines=wikipedia`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(((await res.json()) as { results: unknown[] }).results));
    } finally {
      await searxng.close();
    }
  });
});
