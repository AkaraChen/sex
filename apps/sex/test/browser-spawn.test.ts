// How sex spawns Lightpanda: the command line, and what happens when the binary will not start. Stand-in binaries are used,
// so no browser is needed. The real thing is covered by test/browser.test.ts (SEX_TEST_LIGHTPANDA_PATH).
import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lightpandaArgv } from "../src/engine/browser.ts";
import { testEngine } from "./helpers.ts";

describe("lightpandaArgv", () => {
  const config = { concurrency: 4, allowPrivateNetwork: true };

  test("serves CDP on loopback with connection and message limits", () => {
    expect(lightpandaArgv("/bin/lightpanda", 9222, config)).toEqual([
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
    expect(argv[argv.indexOf("--cdp-max-connections") + 1]).toBe("40");
  });

  test("Lightpanda blocks private networks unless they are allowed", () => {
    expect(lightpandaArgv("/bin/lightpanda", 9222, { ...config, allowPrivateNetwork: false })).toContain("--block-private-networks");
    expect(lightpandaArgv("/bin/lightpanda", 9222, config)).not.toContain("--block-private-networks");
  });

  test("a wrapper goes in front of the binary", () => {
    const argv = lightpandaArgv("/bin/lightpanda", 9222, config, ["setpriv", "--pdeathsig", "TERM", "--"]);
    expect(argv.slice(0, 6)).toEqual(["setpriv", "--pdeathsig", "TERM", "--", "/bin/lightpanda", "serve"]);
  });
});

describe("a Lightpanda binary that does not start", () => {
  const dir = mkdtempSync(join(tmpdir(), "sex-fake-lightpanda-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
    const engine = testEngine({ lightpanda: true, lightpandaPath: fake.bin });
    const started = Date.now();
    const err = await engine.browser.warmup().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: "BROWSER_UNAVAILABLE" });
    expect((err as Error).message).toContain("code 3");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fake.launches()).toBe(1);
    expect(engine.browser.pid).toBeUndefined();
    await engine.close();
  });

  test("a binary that cannot be executed is reported the same way", async () => {
    const bin = join(dir, "not-executable");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o644);
    const engine = testEngine({ lightpanda: true, lightpandaPath: bin });
    const err = await engine.browser.warmup().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: "BROWSER_UNAVAILABLE" });
    await engine.close();
  });

  test("repeated failures pause spawning for a while, then spawning resumes", async () => {
    const fake = exitingBinary("keeps-failing", 1);
    const engine = testEngine({ lightpanda: true, lightpandaPath: fake.bin });
    try {
      for (let i = 0; i < 3; i++) await engine.browser.warmup().catch(() => {});
      expect(fake.launches()).toBe(3);

      const paused = await engine.browser.warmup().catch((e: unknown) => e);
      expect(paused).toMatchObject({ status: 502, code: "BROWSER_UNAVAILABLE" });
      expect((paused as Error).message).toContain("Not starting Lightpanda");
      expect(fake.launches()).toBe(3);

      setSystemTime(new Date(Date.now() + 60_000));
      await engine.browser.warmup().catch(() => {});
      expect(fake.launches()).toBe(4);
    } finally {
      setSystemTime();
      await engine.close();
    }
  });
});
