// How the pool spawns Lightpanda: the command line, and what happens when the binary will not start. Stand-in binaries are used,
// so no browser is needed. The real thing is covered by apps/sex/test/browser.test.ts (SEX_TEST_LIGHTPANDA_PATH).
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, mock, test } from "node:test";
import { BrowserPool, lightpandaArgv } from "@searxng-js/sex-browser";
import { assertFields } from "./support.ts";

describe("lightpandaArgv", () => {
  const config = { concurrency: 4, allowPrivateNetwork: true };

  test("serves CDP on loopback with connection and message limits", () => {
    assert.deepEqual(lightpandaArgv("/bin/lightpanda", 9222, config), [
      "/bin/lightpanda",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "9222",
      "--log-level",
      "warn",
      "--cdp-max-connections",
      "16",
      "--cdp-max-message-size",
      String(64 * 1024 * 1024),
    ]);
  });

  test("the connection limit follows the concurrency", () => {
    const argv = lightpandaArgv("/bin/lightpanda", 9222, { ...config, concurrency: 20 });
    assert.equal(argv[argv.indexOf("--cdp-max-connections") + 1], "40");
  });

  test("Lightpanda blocks private networks unless they are allowed", () => {
    assert.ok(lightpandaArgv("/bin/lightpanda", 9222, { ...config, allowPrivateNetwork: false }).includes("--block-private-networks"));
    assert.ok(!lightpandaArgv("/bin/lightpanda", 9222, config).includes("--block-private-networks"));
  });

  test("a wrapper goes in front of the binary", () => {
    const argv = lightpandaArgv("/bin/lightpanda", 9222, config, ["setpriv", "--pdeathsig", "TERM", "--"]);
    assert.deepEqual(argv.slice(0, 6), ["setpriv", "--pdeathsig", "TERM", "--", "/bin/lightpanda", "serve"]);
  });
});

const poolFor = (lightpandaPath: string) =>
  new BrowserPool({ lightpanda: true, lightpandaPath, concurrency: 4, allowPrivateNetwork: true, blockMedia: false });

describe("a Lightpanda binary that does not start", () => {
  const dir = mkdtempSync(join(tmpdir(), "sex-fake-lightpanda-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  /** A stand-in that appends a line to a log on every launch and then exits with `code`. */
  function exitingBinary(name: string, code: number) {
    const bin = join(dir, name);
    const launchLog = `${bin}.log`;
    writeFileSync(bin, `#!/bin/sh\necho launched >> '${launchLog}'\nexit ${code}\n`);
    chmodSync(bin, 0o755);
    const launches = () => {
      try {
        return readFileSync(launchLog, "utf8").split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    };
    return { bin, launches };
  }

  test("fails right away with BROWSER_UNAVAILABLE and the exit code, not after the startup timeout", async () => {
    const fake = exitingBinary("exits-3", 3);
    const pool = poolFor(fake.bin);
    const started = Date.now();
    const err = await pool.warmup().catch((e: unknown) => e);
    assertFields(err, { status: 502, code: "BROWSER_UNAVAILABLE" });
    assert.ok((err as Error).message.includes("code 3"));
    assert.ok(Date.now() - started < 5_000);
    assert.equal(fake.launches(), 1);
    assert.equal(pool.pid, undefined);
    await pool.close();
  });

  test("a binary that cannot be executed is reported the same way", async () => {
    const bin = join(dir, "not-executable");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o644);
    const pool = poolFor(bin);
    const err = await pool.warmup().catch((e: unknown) => e);
    assertFields(err, { status: 502, code: "BROWSER_UNAVAILABLE" });
    await pool.close();
  });

  test("repeated failures pause spawning for a while, then spawning resumes", async () => {
    const fake = exitingBinary("keeps-failing", 1);
    const pool = poolFor(fake.bin);
    try {
      for (let i = 0; i < 3; i++) await pool.warmup().catch(() => {});
      assert.equal(fake.launches(), 3);

      const paused = await pool.warmup().catch((e: unknown) => e);
      assertFields(paused, { status: 502, code: "BROWSER_UNAVAILABLE" });
      assert.ok((paused as Error).message.includes("Not starting Lightpanda"));
      assert.equal(fake.launches(), 3);

      mock.timers.enable({ apis: ["Date"], now: Date.now() + 60_000 });
      await pool.warmup().catch(() => {});
      assert.equal(fake.launches(), 4);
    } finally {
      mock.timers.reset();
      await pool.close();
    }
  });
});
